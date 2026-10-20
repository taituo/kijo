mod core;
mod render;
mod snapshot;
use std::{env, fs, process::exit};

const WASM: &[u8] = include_bytes!("../../core/scene.wasm");

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let result: Result<(), String> = (|| match cmd {
        // kijo-native parity <scenario.json>   -> snapshot JSON on stdout
        "parity" => {
            let scen: serde_json::Value = serde_json::from_str(&fs::read_to_string(args.get(2).ok_or("scenario path")?).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let mut c = core::Core::new(WASM)?;
            let snap = snapshot::run(&mut c, scen["steps"].as_array().ok_or("scenario.steps")?)?;
            println!("{}", snap);
            Ok(())
        }
        // kijo-native render <out.png> [view=0] [width=1280] [height=800] [scenario.json]
        "render" => {
            let out = args.get(2).ok_or("output path")?;
            let view: i32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let (w, h): (u32, u32) = (args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1280), args.get(5).and_then(|s| s.parse().ok()).unwrap_or(800));
            let mut c = core::Core::new(WASM)?;
            if let Some(p) = args.get(6) {
                let scen: serde_json::Value = serde_json::from_str(&fs::read_to_string(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                snapshot::run(&mut c, scen["steps"].as_array().ok_or("scenario.steps")?)?;
            }
            let info = render::render_png(&mut c, view, w, h, out)?;
            eprintln!("{info}");
            Ok(())
        }
        _ => { eprintln!("usage: kijo-native parity <scenario.json> | render <out.png> [view] [w] [h] [scenario.json]"); Ok(()) }
    })();
    if let Err(e) = result { eprintln!("kijo-native: {e}"); exit(1); }
}
