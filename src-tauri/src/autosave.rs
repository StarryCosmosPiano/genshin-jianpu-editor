use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DAY_MS: u64 = 86_400_000;
static LOCK: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    id: String,
    file_name: String,
    created_at: u64,
    hash: String,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: u32,
    project_path: String,
    records: Vec<BackupRecord>,
    #[serde(default)]
    retired: Vec<BackupRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupWriteResult {
    records: Vec<BackupRecord>,
    warning: Option<String>,
}

fn message(error: impl std::fmt::Display) -> String { error.to_string() }

fn is_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

/// Check every ancestor without following symlinks or Windows junctions.
fn check_path(path: &Path, allow_missing_leaf: bool) -> Result<(), String> {
    let mut current = PathBuf::new();
    let components: Vec<_> = path.components().collect();
    for (index, component) in components.iter().enumerate() {
        if matches!(component, Component::ParentDir) { return Err("自动保存路径不能包含上级目录".into()); }
        current.push(component.as_os_str());
        // A Windows drive prefix is not itself a directory until the root is appended.
        if matches!(component, Component::Prefix(_)) { continue; }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_reparse(&metadata) { return Err("自动保存不支持符号链接、目录联接或重解析点".into()); }
                if index + 1 < components.len() && !metadata.is_dir() { return Err("自动保存路径的父级不是文件夹".into()); }
            }
            Err(error) if allow_missing_leaf && index + 1 == components.len()
                && error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(message(error)),
        }
    }
    Ok(())
}

fn project_directory(project_path: &str, create: bool) -> Result<(PathBuf, PathBuf), String> {
    let source = Path::new(project_path);
    if !source.is_absolute() { return Err("自动保存需要已经保存的绝对文件路径".into()); }
    check_path(source, true)?;
    if let Ok(metadata) = fs::symlink_metadata(source) {
        if !metadata.is_file() { return Err("项目不是普通文件".into()); }
    }
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension != "txt" && extension != "jpwabc" { return Err("只支持 TXT 或 JPW 项目的恢复副本".into()); }
    let parent = source.parent().ok_or("项目没有父文件夹")?;
    let canonical_parent = fs::canonicalize(parent).map_err(message)?;
    check_path(&canonical_parent, false)?;
    let name = source.file_name().ok_or("项目没有文件名")?;
    let project = canonical_parent.join(name);
    let directory = canonical_parent.join(format!("{}.autosave", name.to_string_lossy()));
    check_path(&directory, true)?;
    if directory.exists() {
        if !fs::symlink_metadata(&directory).map_err(message)?.is_dir() { return Err("自动保存目标不是文件夹".into()); }
    } else if create {
        fs::create_dir(&directory).map_err(message)?;
        check_path(&directory, false)?;
    }
    Ok((project, directory))
}

fn record_path(directory: &Path, record: &BackupRecord, missing: bool) -> Result<PathBuf, String> {
    let safe_id = !record.id.is_empty() && record.id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    let file = Path::new(&record.file_name);
    if !safe_id || file.components().count() != 1 || !matches!(file.components().next(), Some(Component::Normal(_)))
        || !record.file_name.starts_with(&format!("backup-{}-{}.", record.created_at, record.id))
        || !matches!(file.extension().and_then(|value| value.to_str()), Some("txt" | "jpwabc")) {
        return Err("恢复历史清单包含不安全的文件名".into());
    }
    let path = directory.join(file);
    check_path(&path, missing)?;
    if path.exists() && !fs::symlink_metadata(&path).map_err(message)?.is_file() { return Err("恢复副本不是普通文件".into()); }
    Ok(path)
}

fn load_manifest(project: &Path, directory: &Path) -> Result<Manifest, String> {
    let file = directory.join("manifest.json");
    check_path(&file, true)?;
    if !file.exists() {
        return Ok(Manifest { version: 1, project_path: project.to_string_lossy().into_owned(), records: vec![], retired: vec![] });
    }
    let metadata = fs::symlink_metadata(&file).map_err(message)?;
    if !metadata.is_file() || metadata.len() > 10_485_760 { return Err("恢复历史清单不是有效文件".into()); }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&file).map_err(message)?).map_err(message)?;
    if manifest.version != 1 || Path::new(&manifest.project_path) != project { return Err("恢复历史属于其他项目".into()); }
    let mut identities = std::collections::HashSet::new();
    for record in manifest.records.iter().chain(manifest.retired.iter()) {
        record_path(directory, record, true)?;
        if !identities.insert(&record.id) { return Err("恢复历史清单含重复版本".into()); }
    }
    Ok(manifest)
}

fn unique_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{:x}-{:x}-{:x}", nanos, std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("没有目标文件夹")?;
    check_path(parent, false)?;
    check_path(path, true)?;
    let temporary = parent.join(format!(".pending-{}.tmp", unique_id()));
    let operation = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(message)?;
        file.write_all(bytes).map_err(message)?;
        file.sync_all().map_err(message)?;
        drop(file);
        check_path(parent, false)?;
        check_path(path, true)?;
        fs::rename(&temporary, path).map_err(message)
    })();
    if operation.is_err() && check_path(&temporary, false).is_ok() { let _ = fs::remove_file(&temporary); }
    operation
}

fn store_manifest(directory: &Path, manifest: &Manifest) -> Result<(), String> {
    atomic_write(&directory.join("manifest.json"), &serde_json::to_vec_pretty(manifest).map_err(message)?)
}

fn retain(records: &[BackupRecord], now: u64, interval_ms: u64, maximum: usize) -> Vec<BackupRecord> {
    let newest_id = records.last().map(|record| record.id.as_str());
    let mut kept: Vec<_> = records.iter().filter(|record| now.saturating_sub(record.created_at) <= DAY_MS).cloned().collect();
    kept.sort_by(|left, right| now.saturating_sub(left.created_at).cmp(&now.saturating_sub(right.created_at))
        .then_with(|| (Some(right.id.as_str()) == newest_id).cmp(&(Some(left.id.as_str()) == newest_id)))
        .then_with(|| right.created_at.cmp(&left.created_at)).then_with(|| right.id.cmp(&left.id)));
    if maximum == 1 { kept.truncate(1); return kept; }
    while kept.len() > maximum {
        let positions: Vec<_> = kept.iter().map(|record| (now.saturating_sub(record.created_at) as f64 / interval_ms as f64).ln_1p()).collect();
        let mut minimum = f64::INFINITY;
        let mut selected = 1;
        for index in 1..kept.len() - 1 {
            let cost = (positions[index] - positions[index - 1]) * (positions[index + 1] - positions[index]);
            if cost < minimum - 1e-12 { minimum = cost; selected = index; }
        }
        kept.remove(selected);
    }
    kept
}

#[tauri::command]
pub fn autosave_write(project_path: String, bytes: Vec<u8>, created_at: u64, interval_ms: u64, max_versions: usize) -> Result<BackupWriteResult, String> {
    let _lock = LOCK.lock().map_err(message)?;
    if interval_ms == 0 || max_versions == 0 { return Err("自动保存间隔和历史份数必须为正整数".into()); }
    let (project, directory) = project_directory(&project_path, true)?;
    let mut manifest = load_manifest(&project, &directory)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if let Some(previous) = manifest.records.iter().max_by_key(|record| record.created_at).filter(|record| record.hash == hash) {
        if let Ok(path) = record_path(&directory, previous, false) {
            if let Ok(existing) = fs::read(path) {
                if format!("{:x}", Sha256::digest(&existing)) == hash {
                    return Ok(BackupWriteResult { records: manifest.records, warning: None });
                }
            }
        }
    }
    let id = unique_id();
    let extension = project.extension().and_then(|value| value.to_str()).unwrap_or("txt").to_ascii_lowercase();
    let record = BackupRecord { file_name: format!("backup-{}-{}.{}", created_at, id, extension), id, created_at, hash };
    let destination = record_path(&directory, &record, true)?;
    atomic_write(&destination, &bytes)?;
    manifest.records.push(record.clone());
    // Publish a durable recovery point before considering any old-file deletion.
    if let Err(error) = store_manifest(&directory, &manifest) {
        if record_path(&directory, &record, false).is_ok() { let _ = fs::remove_file(&destination); }
        return Err(error);
    }
    let kept = retain(&manifest.records, created_at, interval_ms, max_versions);
    let keep_ids: std::collections::HashSet<_> = kept.iter().map(|item| item.id.clone()).collect();
    manifest.retired.extend(manifest.records.iter().filter(|item| !keep_ids.contains(&item.id)).cloned());
    manifest.records = kept;
    if let Err(error) = store_manifest(&directory, &manifest) {
        return Ok(BackupWriteResult { records: load_manifest(&project, &directory)?.records,
            warning: Some(format!("历史整理未完成，旧副本仍保留：{error}")) });
    }
    let mut remaining = vec![];
    let mut errors = vec![];
    for old in &manifest.retired {
        let result = (|| {
            check_path(&directory, false)?;
            let file = record_path(&directory, old, true)?;
            if file.exists() { fs::remove_file(file).map_err(message)?; }
            Ok::<(), String>(())
        })();
        if let Err(error) = result { remaining.push(old.clone()); errors.push(error); }
    }
    manifest.retired = remaining;
    if let Err(error) = store_manifest(&directory, &manifest) { errors.push(error); }
    Ok(BackupWriteResult { records: manifest.records,
        warning: if errors.is_empty() { None } else { Some(format!("部分旧历史未能整理：{}", errors.join("；"))) } })
}

#[tauri::command]
pub fn autosave_list(project_path: String) -> Result<Vec<BackupRecord>, String> {
    let _lock = LOCK.lock().map_err(message)?;
    let (project, directory) = project_directory(&project_path, false)?;
    if !directory.exists() { return Ok(vec![]); }
    let mut manifest = load_manifest(&project, &directory)?;
    manifest.records.retain(|record| directory.join(&record.file_name).is_file());
    manifest.records.sort_by(|left, right| right.created_at.cmp(&left.created_at).then_with(|| right.id.cmp(&left.id)));
    Ok(manifest.records)
}

#[tauri::command]
pub fn autosave_read(project_path: String, id: String) -> Result<Vec<u8>, String> {
    let _lock = LOCK.lock().map_err(message)?;
    let (project, directory) = project_directory(&project_path, false)?;
    if !directory.exists() { return Err("没有找到恢复历史".into()); }
    let manifest = load_manifest(&project, &directory)?;
    let record = manifest.records.iter().find(|record| record.id == id).ok_or("没有找到所选历史版本")?;
    let path = record_path(&directory, record, false)?;
    let bytes = fs::read(path).map_err(message)?;
    if format!("{:x}", Sha256::digest(&bytes)) != record.hash { return Err("恢复副本校验失败，文件可能已损坏".into()); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("jpeditor-backup-test-{}", unique_id()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn project(&self) -> String {
            let path = self.0.join("song.txt");
            fs::write(&path, b"formal").unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    fn safe_test_tree(path: &Path) -> bool {
        let Ok(metadata) = fs::symlink_metadata(path) else { return false; };
        if is_reparse(&metadata) { return false; }
        if !metadata.is_dir() { return true; }
        let Ok(mut entries) = fs::read_dir(path) else { return false; };
        entries.all(|entry| entry.map(|entry| safe_test_tree(&entry.path())).unwrap_or(false))
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            // Failed link/junction tests deliberately leave their sandbox for inspection.
            if self.0.is_absolute() && self.0.file_name().and_then(|name| name.to_str())
                .map(|name| name.starts_with("jpeditor-backup-test-")).unwrap_or(false)
                && safe_test_tree(&self.0) { let _ = fs::remove_dir_all(&self.0); }
        }
    }
    #[test]
    fn retention_real_candidates_and_boundaries() {
        let mut records = vec![];
        for tick in 1..=1440 {
            let now = tick * 120_000;
            records.push(BackupRecord { id: format!("{:x}", tick), file_name: "unused.txt".into(), created_at: now, hash: String::new() });
            records = retain(&records, now, 120_000, 10);
            assert!(records.len() <= 10);
            assert_eq!(records[0].created_at, now);
            assert!(records.iter().all(|record| now - record.created_at <= DAY_MS));
            if tick == 30 {
                assert_eq!(records.iter().map(|record| (now - record.created_at) / 60_000).collect::<Vec<_>>(), vec![0,2,4,6,10,14,18,26,42,58]);
            }
        }
    }
    #[test]
    fn copies_do_not_overwrite_formal_or_unmanaged_files() {
        let root = Sandbox::new();
        let project = root.project();
        let first = autosave_write(project.clone(), b"first".to_vec(), 120_000, 120_000, 1).unwrap();
        let (_, directory) = project_directory(&project, false).unwrap();
        let unrelated = directory.join("user-note.txt");
        fs::write(&unrelated, b"keep").unwrap();
        let second = autosave_write(project.clone(), b"second".to_vec(), 240_000, 120_000, 1).unwrap();
        assert_eq!(second.records.len(), 1);
        assert_eq!(fs::read(&project).unwrap(), b"formal");
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        assert!(!directory.join(&first.records[0].file_name).exists());
        assert_eq!(autosave_read(project, second.records[0].id.clone()).unwrap(), b"second");
    }
    #[test]
    fn invalid_paths_and_corrupt_manifest_are_not_deleted() {
        let root = Sandbox::new();
        assert!(project_directory("relative.txt", true).is_err());
        let parent = root.0.join("..\u{002f}outside.txt");
        assert!(project_directory(parent.to_str().unwrap(), true).is_err());
        let project = root.project();
        let first = autosave_write(project.clone(), b"first".to_vec(), 120_000, 120_000, 1).unwrap();
        let (path, directory) = project_directory(&project, false).unwrap();
        let mut manifest = load_manifest(&path, &directory).unwrap();
        manifest.records[0].file_name = "../outside.txt".into();
        store_manifest(&directory, &manifest).unwrap();
        assert!(autosave_write(project, b"new".to_vec(), DAY_MS * 2, 120_000, 1).is_err());
        assert!(directory.join(&first.records[0].file_name).exists());
    }
    #[test]
    fn corrupted_recovery_is_rejected_and_can_be_replaced() {
        let root = Sandbox::new();
        let project = root.project();
        let first = autosave_write(project.clone(), b"first".to_vec(), 120_000, 120_000, 1).unwrap();
        let (_, directory) = project_directory(&project, false).unwrap();
        fs::write(directory.join(&first.records[0].file_name), b"corrupt").unwrap();
        assert!(autosave_read(project.clone(), first.records[0].id.clone()).is_err());
        let repaired = autosave_write(project.clone(), b"first".to_vec(), 240_000, 120_000, 1).unwrap();
        assert_ne!(repaired.records[0].id, first.records[0].id);
        assert_eq!(autosave_read(project, repaired.records[0].id.clone()).unwrap(), b"first");
    }
    #[cfg(windows)]
    #[test]
    fn failed_manifest_publication_preserves_previous_recovery() {
        let root = Sandbox::new();
        let project = root.project();
        let first = autosave_write(project.clone(), b"first".to_vec(), 120_000, 120_000, 1).unwrap();
        let (_, directory) = project_directory(&project, false).unwrap();
        let manifest = directory.join("manifest.json");
        let original = fs::metadata(&manifest).unwrap().permissions();
        let mut read_only = original.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&manifest, read_only).unwrap();
        let result = autosave_write(project.clone(), b"second".to_vec(), DAY_MS * 2, 120_000, 1);
        fs::set_permissions(&manifest, original).unwrap();
        assert!(result.is_err());
        assert!(directory.join(&first.records[0].file_name).exists());
        assert_eq!(autosave_read(project, first.records[0].id.clone()).unwrap(), b"first");
    }
    #[test]
    fn symlink_or_junction_is_rejected() {
        let root = Sandbox::new();
        let project = root.project();
        let (_, directory) = project_directory(&project, false).unwrap();
        let other = root.0.join("other");
        fs::create_dir(&other).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&other, &directory).unwrap();
        #[cfg(windows)]
        {
            // Junctions require no elevated symlink privilege on Windows.
            let result = std::process::Command::new("cmd").args(["/c", "mklink", "/J"])
                .arg(&directory).arg(&other).output().unwrap();
            assert!(result.status.success());
        }
        assert!(project_directory(&project, true).is_err());
        let _ = fs::remove_dir(&directory);
    }
}
