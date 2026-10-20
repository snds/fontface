//! The part that talks to CoreText: the font request listener, and turning what a request holds
//! into JSON. Everything here is small on purpose, because the callback runs on the main thread
//! while another app waits for its answer.
//!
//! **The call.** From CoreText's header (CTFontManager.h, "Manager Auto-Activation"):
//!
//! ```c
//! CFRunLoopSourceRef _Nullable CTFontManagerCreateFontRequestRunLoopSource(
//!     CFIndex sourceOrder,
//!     CFArrayRef (^createMatchesCallback)(CFDictionaryRef requestAttributes, pid_t requestingProcess));
//! ```
//!
//! "Creates a CFRunLoopSourceRef that will be used to convey font requests from CTFontManager
//! ... A CFRunLoopSourceRef that should be added to the run loop. To stop receiving requests,
//! invalidate this run loop source. Will return NULL on error." Apple marks it deprecated since
//! macOS 11 ("will be removed in a future release"), so it's looked up by name when the test
//! starts, never linked: if it's gone, Fontface still launches and the log says so.
//!
//! **Memory.** The source comes from a Create function, so Fontface owns it (Core Foundation's
//! Create rule); it's kept until Fontface quits. The request dictionary isn't Fontface's
//! (it's passed in): it's read during the callback and never released. The callback's name says
//! it creates the array it returns, so it returns a new, empty array that CoreText then owns.
//! If CoreText didn't release it, that would leak one empty array per request, never crash.
//!
//! **Threads.** The source goes on the main thread's run loop (Tauri's event loop on macOS) in
//! its common modes, so a request is answered even while a menu is open. The callback only
//! copies the request into JSON, queues it for the log's own thread and answers "no fonts":
//! nothing that waits, and no panic ever crosses into CoreText (`catch_unwind`).

use std::ffi::{c_char, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};

use block2::{Block, RcBlock};
use core_foundation::array::{kCFTypeArrayCallBacks, CFArrayCreate, CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{kCFAllocatorDefault, CFCopyDescription, CFGetTypeID, CFIndex, CFNullGetTypeID, CFTypeID, CFTypeRef, TCFType};
use core_foundation::data::{CFDataGetLength, CFDataGetTypeID};
use core_foundation::dictionary::{CFDictionary, CFDictionaryGetTypeID, CFDictionaryRef};
use core_foundation::number::{CFBooleanGetTypeID, CFBooleanGetValue, CFNumber, CFNumberGetTypeID, CFNumberIsFloatType};
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetMain, CFRunLoopSourceRef};
use core_foundation::string::{CFString, CFStringGetTypeID, CFStringRef};
use core_foundation::url::{CFURLGetString, CFURLGetTypeID};
use core_text::font_descriptor::{CTFontDescriptorCopyAttributes, CTFontDescriptorGetTypeID};
use serde_json::{Map, Value};

/// How deep a request is copied; anything deeper is left out ("…").
const MAX_DEPTH: usize = 12;
/// At most this many items of a list, and keys of a dictionary.
const MAX_ITEMS: usize = 200;
/// Longer strings are cut to this many characters.
const MAX_CHARS: usize = 1000;

/// The callback CoreText calls: the request's attributes and the asking process.
type RequestFn = dyn Fn(*const c_void, i32) -> *const c_void;
type CreateSourceFn = unsafe extern "C" fn(CFIndex, *mut Block<RequestFn>) -> CFRunLoopSourceRef;
type GetSettingFn = unsafe extern "C" fn(CFStringRef) -> u32;

/// A symbol in the libraries Fontface has loaded (CoreText is one), or None if it isn't there.
pub(super) fn symbol(name: &CStr) -> Option<*mut c_void> {
    // SAFETY: dlsym only looks the name up.
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr() as *const c_char) };
    (!found.is_null()).then_some(found)
}

/// Starts listening: makes the request source and adds it to the main run loop. Call it on the
/// main thread. `queue` gets each request (as JSON) with the asking process's id; it must not
/// wait. The answer to every request is "no fonts". Err says why it couldn't start.
pub fn start(queue: fn(i32, Value)) -> Result<(), String> {
    let Some(create) = symbol(c"CTFontManagerCreateFontRequestRunLoopSource") else {
        return Err("this macOS no longer has CoreText's font request listener (CTFontManagerCreateFontRequestRunLoopSource)".into());
    };
    // SAFETY: the symbol has this signature (CTFontManager.h, quoted at the top of this file).
    let create: CreateSourceFn = unsafe { std::mem::transmute::<*mut c_void, CreateSourceFn>(create) };
    let block = RcBlock::new(move |request: *const c_void, pid: i32| -> *const c_void {
        // Nothing may unwind into CoreText. A request that can't be copied is simply not logged.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: CoreText passes a valid dictionary (or null) for the call's length.
            let json = unsafe { to_json(request as CFTypeRef, 0) };
            queue(pid, json);
        }));
        no_fonts()
    });
    // The block lives as long as the source does: until Fontface quits.
    let block = RcBlock::into_raw(block);
    // SAFETY: a valid block of the right shape; order 0 like any other source.
    let source = unsafe { create(0, block) };
    if source.is_null() {
        return Err("CoreText didn't make a font request listener (another one may already be listening in this app)".into());
    }
    // SAFETY: the main run loop and a valid source. The source is kept (+1) until Fontface quits.
    unsafe { CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes) };
    Ok(())
}

/// The answer to every request: a new, empty list of fonts. CoreText owns it (Create rule).
fn no_fonts() -> *const c_void {
    // SAFETY: an empty array with the standard callbacks.
    unsafe { CFArrayCreate(kCFAllocatorDefault, std::ptr::null(), 0, &kCFTypeArrayCallBacks) as *const c_void }
}

/// Reads an auto-activation setting: an app's (by bundle id), or with None the global one.
/// None if this macOS doesn't have the call. Only reads.
pub fn auto_activation_setting(bundle_id: Option<&str>) -> Option<u32> {
    let get = symbol(c"CTFontManagerGetAutoActivationSetting")?;
    // SAFETY: the symbol has this signature (CTFontManager.h).
    let get: GetSettingFn = unsafe { std::mem::transmute::<*mut c_void, GetSettingFn>(get) };
    match bundle_id {
        Some(id) => {
            let id = CFString::new(id);
            // SAFETY: a valid string for the call's length.
            Some(unsafe { get(id.as_concrete_TypeRef()) })
        }
        None => {
            // The global setting is asked for with kCTFontManagerBundleIdentifier (a variable).
            let global = symbol(c"kCTFontManagerBundleIdentifier")? as *const CFStringRef;
            // SAFETY: the variable holds a constant string.
            let global = unsafe { *global };
            if global.is_null() {
                return None;
            }
            // SAFETY: as above.
            Some(unsafe { get(global) })
        }
    }
}

/// A string as JSON, cut to MAX_CHARS characters.
fn text(s: String) -> Value {
    if s.chars().count() <= MAX_CHARS {
        return Value::String(s);
    }
    Value::String(format!("{}…", s.chars().take(MAX_CHARS).collect::<String>()))
}

/// What a Core Foundation value holds, as JSON: strings, numbers, true and false, lists and
/// dictionaries as they are; a font descriptor as its attributes; data as its length; a URL as
/// its text; anything else as its description. Limited in depth, length and size.
///
/// # Safety
/// `value` is null or a valid Core Foundation object for the call's length.
pub unsafe fn to_json(value: CFTypeRef, depth: usize) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    if depth > MAX_DEPTH {
        return Value::String("…".into());
    }
    let kind: CFTypeID = CFGetTypeID(value);
    if kind == CFStringGetTypeID() {
        return text(CFString::wrap_under_get_rule(value as CFStringRef).to_string());
    }
    if kind == CFBooleanGetTypeID() {
        return Value::Bool(CFBooleanGetValue(value as _));
    }
    if kind == CFNumberGetTypeID() {
        let n = CFNumber::wrap_under_get_rule(value as _);
        let float = CFNumberIsFloatType(value as _) != 0;
        return match (float, n.to_i64(), n.to_f64()) {
            (false, Some(i), _) => Value::from(i),
            (_, _, Some(f)) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
            _ => Value::Null,
        };
    }
    if kind == CFArrayGetTypeID() {
        let array = value as CFArrayRef;
        let n = CFArrayGetCount(array).max(0) as usize;
        let mut out: Vec<Value> = (0..n.min(MAX_ITEMS)).map(|i| to_json(CFArrayGetValueAtIndex(array, i as CFIndex), depth + 1)).collect();
        if n > MAX_ITEMS {
            out.push(Value::String(format!("… {} more", n - MAX_ITEMS)));
        }
        return Value::Array(out);
    }
    if kind == CFDictionaryGetTypeID() {
        return dictionary(value as CFDictionaryRef, depth);
    }
    if kind == CTFontDescriptorGetTypeID() {
        let attributes = CTFontDescriptorCopyAttributes(value as _);
        if attributes.is_null() {
            return Value::Object(Map::new());
        }
        let out = dictionary(attributes, depth);
        // Copied for this call (Create rule): released here.
        core_foundation::base::CFRelease(attributes as CFTypeRef);
        return out;
    }
    if kind == CFDataGetTypeID() {
        return Value::String(format!("<{} bytes>", CFDataGetLength(value as _)));
    }
    if kind == CFURLGetTypeID() {
        let s = CFURLGetString(value as _);
        return if s.is_null() { Value::Null } else { text(CFString::wrap_under_get_rule(s).to_string()) };
    }
    if kind == CFNullGetTypeID() {
        return Value::Null;
    }
    let description = CFCopyDescription(value);
    if description.is_null() {
        return Value::String("<unknown>".into());
    }
    text(CFString::wrap_under_create_rule(description).to_string())
}

/// A dictionary as a JSON object: each key as its text, sorted, at most MAX_ITEMS of them.
///
/// # Safety
/// `dict` is a valid dictionary for the call's length.
unsafe fn dictionary(dict: CFDictionaryRef, depth: usize) -> Value {
    let dict: CFDictionary = CFDictionary::wrap_under_get_rule(dict);
    let (keys, values) = dict.get_keys_and_values();
    let mut out = Map::new();
    for (key, value) in keys.into_iter().zip(values).take(MAX_ITEMS) {
        let name = match to_json(key, depth + 1) {
            Value::String(s) => s,
            other => other.to_string(),
        };
        out.insert(name, to_json(value, depth + 1));
    }
    if dict.len() > MAX_ITEMS {
        out.insert("…".into(), Value::String(format!("{} more", dict.len() - MAX_ITEMS)));
    }
    Value::Object(out)
}
