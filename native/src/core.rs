//! The Kijo WASM core, hosted natively with wasmi. Same bytes as the browser loads (core/scene.wasm),
//! same ABI v2: this file is the native twin of src/core.mjs and decodes nothing the ABI does not define.
use wasmi::{Engine, Instance, Linker, Memory, Module, Store, Val};

pub const TILE_SIZE: usize = 10;
pub const NODE_SIZE: usize = 15;
pub const EVENT_SIZE: usize = 5;
pub const VIEWS: usize = 5; // focus, overview, back, timeline, workspaces

pub struct Core {
    store: Store<()>,
    inst: Instance,
    mem: Memory,
}

impl Core {
    pub fn new(wasm: &[u8]) -> Result<Core, String> {
        let engine = Engine::default();
        let module = Module::new(&engine, wasm).map_err(|e| e.to_string())?;
        let mut store = Store::new(&engine, ());
        let inst = Linker::<()>::new(&engine).instantiate_and_start(&mut store, &module).map_err(|e| e.to_string())?;
        let mem = inst.get_memory(&store, "memory").ok_or("core exports no memory")?;
        let mut c = Core { store, inst, mem };
        if c.call("kijo_version", &[])? != 2 { return Err("unsupported Kijo scene ABI".into()); }
        c.call("kijo_reset", &[])?;
        Ok(c)
    }

    /// Call any export by name with i32 arguments; exports with no result return 0 (same as JS `undefined`-ish use).
    pub fn call(&mut self, name: &str, args: &[i32]) -> Result<i32, String> {
        let f = self.inst.get_func(&self.store, name).ok_or_else(|| format!("no export {name}"))?;
        let vals: Vec<Val> = args.iter().map(|&a| Val::I32(a)).collect();
        let mut out = vec![Val::I32(0); f.ty(&self.store).results().len()];
        f.call(&mut self.store, &vals, &mut out).map_err(|e| format!("{name}: {e}"))?;
        Ok(match out.first() { Some(Val::I32(v)) => *v, _ => 0 })
    }
    pub fn c(&mut self, name: &str) -> i32 { self.call(name, &[]).unwrap_or(-1) }

    fn ints(&self, ptr: i32, count: usize) -> Vec<i32> {
        let data = self.mem.data(&self.store);
        let at = ptr as usize;
        data[at..at + count * 4].chunks_exact(4).map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
    }

    pub fn tiles(&mut self, ws: Option<i32>) -> Vec<i32> {
        let n = self.c("kijo_tile_count") as usize;
        let ptr = match ws { None => self.c("kijo_tile_ptr"), Some(w) => self.call("kijo_ws_tile_ptr", &[w]).unwrap_or(0) };
        self.ints(ptr, n * TILE_SIZE)
    }
    pub fn scene(&mut self, view: i32) -> Vec<i32> {
        self.call("kijo_build_scene", &[view]).ok();
        let n = self.c("kijo_node_count") as usize;
        let ptr = self.c("kijo_node_ptr");
        self.ints(ptr, n * NODE_SIZE)
    }
    pub fn events(&mut self) -> (i32, Vec<i32>) {
        let (total, cap, ptr) = (self.c("kijo_event_total"), self.c("kijo_event_capacity") as usize, self.c("kijo_event_ptr"));
        (total, self.ints(ptr, cap * EVENT_SIZE))
    }
}
