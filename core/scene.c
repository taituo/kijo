#include <stdint.h>

// Kijo v0 scene ABI. All integers are little-endian i32 in WebAssembly linear memory.
// A render host may map these to terminal glyphs, native GPU primitives, or network frames.
#define SIDE 6
#define CAPACITY 128

enum { EMPTY = 0, REAL = 1, GHOST = 2 };
enum { IDLE = 0, WORKING = 1, BLOCKED = 2, ERROR = 3, COMPLETE = 4 };
enum { VIEW_FOCUS = 0, VIEW_OVERVIEW = 1, VIEW_BACK = 2, VIEW_TIMELINE = 3 };
enum { NODE_SLOT = 1, NODE_TILE = 2, NODE_GHOST = 3, NODE_LINK = 4, NODE_EVENT = 5 };

typedef struct {
    int32_t id, kind, status, owner_id, group_id, created_tx, flags;
} Tile;

typedef struct {
    int32_t kind, id, x, y, w, h, status, owner_id, group_id;
    int32_t flags, material_id, shader_id, meta;
} Node;

static Tile tiles[SIDE * SIDE];
static Node nodes[CAPACITY];
static int32_t node_count = 0;
static int32_t focus_x = 1, focus_y = 1, next_id = 100;
static int32_t transaction_id = 1;

static int32_t bounded(int32_t v, int32_t a, int32_t b) { return v < a ? a : (v > b ? b : v); }
static int32_t idx(int32_t x, int32_t y) { return (x >= 0 && x < SIDE && y >= 0 && y < SIDE) ? (y * SIDE + x) : -1; }
static void put(int32_t x, int32_t y, int32_t id, int32_t kind, int32_t status, int32_t owner, int32_t group, int32_t tx) {
    int32_t i = idx(x, y);
    if (i < 0) return;
    Tile t = {id, kind, status, owner, group, tx, 0};
    tiles[i] = t;
}

__attribute__((export_name("kijo_reset")))
void kijo_reset(void) {
    for (int i = 0; i < SIDE * SIDE; i++) { Tile zero = {0}; tiles[i] = zero; }
    focus_x = 1; focus_y = 1; node_count = 0;
    transaction_id = 1; next_id = 100;
    // One 2x2 reservation: 1 visible terminal, 3 invisible owned placeholders.
    put(1,1,-1,GHOST,IDLE,1,1,transaction_id);
    put(2,1,-1,GHOST,IDLE,1,1,transaction_id);
    put(1,2,-1,GHOST,IDLE,1,1,transaction_id);
    put(2,2, 1,REAL,IDLE,0,1,transaction_id);
    put(4,0, 2,REAL,WORKING,0,2,++transaction_id); // simulated agent
    put(0,4, 3,REAL,IDLE,0,3,++transaction_id); // host metrics
    put(5,5, 4,REAL,BLOCKED,0,4,++transaction_id); // remote connection (unconfigured)
}

__attribute__((export_name("kijo_version"))) int32_t kijo_version(void) { return 1; }
__attribute__((export_name("kijo_tile_ptr"))) int32_t kijo_tile_ptr(void) { return (int32_t)(uintptr_t)&tiles[0]; }
__attribute__((export_name("kijo_tile_count"))) int32_t kijo_tile_count(void) { return SIDE * SIDE; }
__attribute__((export_name("kijo_node_ptr"))) int32_t kijo_node_ptr(void) { return (int32_t)(uintptr_t)&nodes[0]; }
__attribute__((export_name("kijo_node_count"))) int32_t kijo_node_count(void) { return node_count; }
__attribute__((export_name("kijo_focus_x"))) int32_t kijo_focus_x(void) { return focus_x; }
__attribute__((export_name("kijo_focus_y"))) int32_t kijo_focus_y(void) { return focus_y; }
__attribute__((export_name("kijo_focus_set")))
void kijo_focus_set(int32_t x, int32_t y) { focus_x = bounded(x,0,4); focus_y = bounded(y,0,4); }
__attribute__((export_name("kijo_focus_move")))
void kijo_focus_move(int32_t dx, int32_t dy) { kijo_focus_set(focus_x+dx,focus_y+dy); }

__attribute__((export_name("kijo_at")))
int32_t kijo_at(int32_t x, int32_t y) { return idx(x,y); }

__attribute__((export_name("kijo_promote_ghost")))
int32_t kijo_promote_ghost(int32_t x, int32_t y) {
    int32_t i = idx(x,y);
    if (i < 0 || tiles[i].kind != GHOST) return 0;
    int32_t new_id = next_id++;
    // Ownership MUST be detached when independently occupied.
    put(x,y,new_id,REAL,IDLE,0,new_id,++transaction_id);
    return new_id;
}

__attribute__((export_name("kijo_close")))
int32_t kijo_close(int32_t id) {
    int32_t owner_group = 0, owner_tx = 0, found = 0;
    for (int i=0;i<SIDE*SIDE;i++) if(tiles[i].kind==REAL && tiles[i].id==id) {
        owner_group = tiles[i].group_id; owner_tx = tiles[i].created_tx;
        Tile zero = {0}; tiles[i] = zero; found = 1; break;
    }
    if (!found) return 0;
    // Exact ownership + creation transaction guard. Other tiles are never touched.
    for (int i=0;i<SIDE*SIDE;i++) if (tiles[i].kind==GHOST &&
        tiles[i].owner_id == id && tiles[i].group_id == owner_group &&
        tiles[i].created_tx == owner_tx) {
        Tile zero = {0}; tiles[i] = zero;
    }
    return 1;
}

__attribute__((export_name("kijo_status")))
int32_t kijo_status(int32_t id,int32_t status) {
    if(status<0 || status>4) return 0;
    for(int i=0;i<SIDE*SIDE;i++) if(tiles[i].id==id && tiles[i].kind==REAL) { tiles[i].status=status; return 1; }
    return 0;
}

__attribute__((export_name("kijo_restore_tile")))
void kijo_restore_tile(int32_t index, int32_t id, int32_t kind, int32_t status,
    int32_t owner, int32_t group, int32_t tx, int32_t flags) {
    if(index < 0 || index >= SIDE*SIDE || kind < 0 || kind > 2) return;
    Tile t = {id,kind,status,owner,group,tx,flags}; tiles[index] = t;
    if(id >= next_id) next_id = id+1;
    if(tx >= transaction_id) transaction_id = tx+1;
}

static void emit(int32_t kind, int32_t id, int32_t x, int32_t y, int32_t w,
                 int32_t h, int32_t status, int32_t owner, int32_t group,
                 int32_t flags, int32_t material, int32_t shader, int32_t meta) {
    if(node_count>=CAPACITY) return;
    Node n={kind,id,x,y,w,h,status,owner,group,flags,material,shader,meta};
    nodes[node_count++]=n;
}

// IMPORTANT: The host does not invent layout. WASM produces a declarative scene.
// Coordinates are normalized to 0..1000; render targets decide pixels/glyphs.
__attribute__((export_name("kijo_build_scene")))
int32_t kijo_build_scene(int32_t view) {
    node_count=0;
    if(view==VIEW_FOCUS) {
        for(int ry=0;ry<2;ry++) for(int rx=0;rx<2;rx++) {
            int32_t i=idx(focus_x+rx,focus_y+ry);
            Tile t=tiles[i];
            int32_t kind=t.kind==REAL?NODE_TILE:(t.kind==GHOST?NODE_GHOST:NODE_SLOT);
            emit(kind,t.id,rx*500,ry*500,500,500,t.status,t.owner_id,t.group_id,t.flags,
                 t.kind==GHOST?2:1,t.status==WORKING?1:0,i);
        }
    } else if(view==VIEW_OVERVIEW) {
        for(int y=0;y<6;y++) for(int x=0;x<6;x++) {
            int32_t i=idx(x,y); Tile t=tiles[i];
            int32_t kind=t.kind==REAL?NODE_TILE:(t.kind==GHOST?NODE_GHOST:NODE_SLOT);
            emit(kind,t.id,x*1000/6,y*1000/6,1000/6,1000/6,t.status,t.owner_id,t.group_id,t.flags,
                 t.kind==GHOST?2:1,t.status==WORKING?1:0,i);
        }
    } else if(view==VIEW_BACK) {
        for(int i=0;i<SIDE*SIDE;i++) {
            Tile t=tiles[i];
            if(t.kind==REAL) emit(NODE_TILE,t.id,(i%SIDE)*1000/6,(i/SIDE)*1000/6,160,160,t.status,0,t.group_id,0,3,0,i);
            if(t.kind==GHOST) emit(NODE_LINK,t.id,(i%SIDE)*1000/6,(i/SIDE)*1000/6,160,160,t.status,t.owner_id,t.group_id,0,2,0,i);
        }
    } else if(view==VIEW_TIMELINE) {
        for(int i=0;i<SIDE*SIDE;i++) if(tiles[i].kind==REAL) {
            Tile t=tiles[i]; emit(NODE_EVENT,t.id,0,node_count*180,1000,150,t.status,0,t.group_id,0,1,0,i);
        }
    }
    return node_count;
}
