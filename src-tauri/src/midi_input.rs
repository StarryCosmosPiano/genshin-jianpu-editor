//! Windows MIDI input through WinMM; no SysEx buffers or MIDI output are opened.
//! ABI/lifetime references: Microsoft midiInOpen, MidiInProc, midiInReset,
//! midiInClose and MIDIINCAPSW documentation (mmeapi.h).

use serde::Serialize;

#[derive(Serialize)]
pub struct MidiInputDevice {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct MidiInputMessage {
    data: Vec<u8>,
    timestamp: u32,
}

#[cfg(target_os = "windows")]
mod winmm {
    use super::{MidiInputDevice, MidiInputMessage};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::ipc::Channel;

    const CALLBACK_FUNCTION: u32 = 0x0003_0000;
    const MIM_DATA: u32 = 0x03c3;
    const MIM_MOREDATA: u32 = 0x03cc;

    // WORD = u16, MMVERSION/DWORD/UINT/MMRESULT = u32; handles and
    // DWORD_PTR/UINT_PTR are pointer-sized on both 32- and 64-bit Windows.
    #[repr(C)]
    #[derive(Default)]
    struct MidiInCaps {
        manufacturer: u16,
        product: u16,
        driver_version: u32,
        name: [u16; 32],
        support: u32,
    }

    #[link(name = "winmm")]
    extern "system" {
        fn midiInGetNumDevs() -> u32;
        fn midiInGetDevCapsW(device_id: usize, caps: *mut MidiInCaps, size: u32) -> u32;
        fn midiInOpen(handle: *mut usize, device_id: u32, callback: usize, instance: usize, flags: u32) -> u32;
        fn midiInStart(handle: usize) -> u32;
        fn midiInStop(handle: usize) -> u32;
        fn midiInReset(handle: usize) -> u32;
        fn midiInClose(handle: usize) -> u32;
        fn midiInGetErrorTextW(error: u32, text: *mut u16, size: u32) -> u32;
    }

    fn error(action: &str, code: u32) -> String {
        let mut text = [0u16; 256];
        let ok = unsafe { midiInGetErrorTextW(code, text.as_mut_ptr(), text.len() as u32) } == 0;
        let end = text.iter().position(|value| *value == 0).unwrap_or(text.len());
        if ok { format!("{action}：{} ({code})", String::from_utf16_lossy(&text[..end])) }
        else { format!("{action}：Windows MIDI 错误 {code}") }
    }

    fn device(index: u32) -> Option<MidiInputDevice> {
        let mut caps = MidiInCaps::default();
        let result = unsafe { midiInGetDevCapsW(index as usize, &mut caps, std::mem::size_of::<MidiInCaps>() as u32) };
        if result != 0 { return None; }
        let end = caps.name.iter().position(|value| *value == 0).unwrap_or(caps.name.len());
        let name = String::from_utf16_lossy(&caps.name[..end]);
        // Include identity as well as index: hotplug can renumber WinMM ports.
        // Never silently connect a different device now occupying an old index.
        let id = format!("winmm:{index}:{}:{}:{name}", caps.manufacturer, caps.product);
        Some(MidiInputDevice { id, name })
    }

    pub fn list() -> Vec<MidiInputDevice> {
        (0..unsafe { midiInGetNumDevs() }).filter_map(device).collect()
    }

    struct CallbackContext {
        active: AtomicBool,
        channel: Channel<MidiInputMessage>,
    }

    /// MIM_DATA packs status/data1/data2 in the low three bytes of dwParam1;
    /// dwParam2 is milliseconds since midiInStart. Only needed channel messages
    /// and reset reach the UI; clocks, sensing, SysEx and malformed data do not.
    fn unpack(message: usize) -> Option<Vec<u8>> {
        let status = (message & 0xff) as u8;
        if status == 0xff { return Some(vec![status]); }
        if !matches!(status & 0xf0, 0x80 | 0x90 | 0xb0) { return None; }
        let first = ((message >> 8) & 0xff) as u8;
        let second = ((message >> 16) & 0xff) as u8;
        if first >= 128 || second >= 128 { return None; }
        Some(vec![status, first, second])
    }

    unsafe extern "system" fn on_input(_handle: usize, message: u32, instance: usize, packed: usize, timestamp: usize) {
        if instance == 0 || !matches!(message, MIM_DATA | MIM_MOREDATA) { return; }
        // Box allocation remains alive until midiInClose has completed. The
        // callback never locks connection state or calls a multimedia function.
        let context = &*(instance as *const CallbackContext);
        if !context.active.load(Ordering::Acquire) { return; }
        if let Some(data) = unpack(packed) {
            let _ = context.channel.send(MidiInputMessage { data, timestamp: timestamp as u32 });
        }
    }

    pub struct Connection {
        pub id: String,
        handle: usize,
        context: Option<Box<CallbackContext>>,
    }

    impl Connection {
        pub fn open(device_id: &str, id: String, channel: Channel<MidiInputMessage>) -> Result<Self, String> {
            let index = (0..unsafe { midiInGetNumDevs() })
                .find(|index| device(*index).is_some_and(|device| device.id == device_id))
                .ok_or("所选 MIDI 设备已断开，请刷新设备列表。")?;
            let context = Box::new(CallbackContext { active: AtomicBool::new(false), channel });
            let mut handle = 0usize;
            let result = unsafe {
                midiInOpen(&mut handle, index, on_input as *const () as usize,
                    &*context as *const CallbackContext as usize, CALLBACK_FUNCTION)
            };
            if result != 0 { return Err(error("无法打开 MIDI 设备", result)); }
            let connection = Self { id, handle, context: Some(context) };
            connection.context.as_ref().unwrap().active.store(true, Ordering::Release);
            let result = unsafe { midiInStart(handle) };
            if result != 0 { return Err(error("无法启动 MIDI 输入", result)); }
            Ok(connection)
        }

        pub fn close(&mut self) -> Result<(), String> {
            if self.handle == 0 { return Ok(()); }
            if let Some(context) = &self.context { context.active.store(false, Ordering::Release); }
            // Reset returns any queued input before close. No SysEx buffers are
            // registered, so normal close has no outstanding MIDIHDR ownership.
            unsafe { midiInStop(self.handle); midiInReset(self.handle); }
            let result = unsafe { midiInClose(self.handle) };
            if result == 0 {
                self.handle = 0;
                self.context.take();
                Ok(())
            } else { Err(error("无法关闭 MIDI 设备", result)) }
        }
    }

    impl Drop for Connection {
        fn drop(&mut self) {
            if self.close().is_err() {
                // A faulty driver may reject close. Retain the inactive context
                // rather than leave its callback with a dangling pointer.
                if let Some(context) = self.context.take() { Box::leak(context); }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn winmm_abi_and_short_messages() {
            assert_eq!(std::mem::size_of::<MidiInCaps>(), 76);
            assert_eq!(std::mem::align_of::<MidiInCaps>(), 4);
            assert_eq!(unpack(0x007f3c90), Some(vec![0x90, 60, 127]));
            assert_eq!(unpack(0x00003c92), Some(vec![0x92, 60, 0]));
            assert_eq!(unpack(0x00007bb0), Some(vec![0xb0, 123, 0]));
            assert_eq!(unpack(0xff), Some(vec![0xff]));
            assert_eq!(unpack(0xf8), None);
            assert_eq!(unpack(0x00803c90), None);
            assert_eq!(unpack(0x000000f0), None);
        }
    }
}

#[derive(Default)]
pub struct MidiInputState {
    #[cfg(target_os = "windows")]
    connection: std::sync::Mutex<Option<winmm::Connection>>,
}

#[tauri::command]
pub fn midi_input_available() -> bool { cfg!(target_os = "windows") }

#[tauri::command]
pub fn midi_input_list() -> Result<Vec<MidiInputDevice>, String> {
    #[cfg(target_os = "windows")]
    { Ok(winmm::list()) }
    #[cfg(not(target_os = "windows"))]
    { Err("此平台暂无原生 MIDI 输入。".into()) }
}

#[tauri::command]
pub fn midi_input_connect(
    device_id: String,
    connection_id: String,
    on_message: tauri::ipc::Channel<MidiInputMessage>,
    state: tauri::State<'_, MidiInputState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut connection = state.connection.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = connection.as_mut() { previous.close()?; }
        *connection = None;
        *connection = Some(winmm::Connection::open(&device_id, connection_id, on_message)?);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (device_id, connection_id, on_message, state);
        Err("此平台暂无原生 MIDI 输入。".into())
    }
}

#[tauri::command]
pub fn midi_input_disconnect(connection_id: String, state: tauri::State<'_, MidiInputState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut connection = state.connection.lock().map_err(|error| error.to_string())?;
        // Late disposal of a superseded JS connection must not close its successor.
        if connection.as_ref().is_some_and(|current| current.id == connection_id) {
            if let Some(current) = connection.as_mut() { current.close()?; }
            *connection = None;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (connection_id, state); Ok(()) }
}
