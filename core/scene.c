#include <stdint.h>

// Kijo scene ABI v2. All integers are little-endian i32 in WebAssembly linear memory.
// The core owns: workspaces, slot occupancy, ghost ownership, selection, focus viewport,
// status, and scene generation. Hosts (terminal, Chrome/WebGPU, native) only draw nodes.
//
// Model: Hyprland-style workspaces and dispatchers over a stable 6x6 slot grid.
// Ghost tiles reserve slots so neighbours never auto-expand (see kijo_spawn / kijo_close).
#define SIDE 6
#define CELLS 36
#define NWS 10            // 0..8 = workspaces 1..9, 9 = special (scratchpad)
#define SPECIAL_WS 9
#define CAPACITY 192
#define SCALE 6000        // scene coordinate space: 6000 x 6000 (1 slot = 1000)
#define EVENTS 64

enum { EMPTY = 0, REAL = 1, GHOST = 2 };
// Same vocabulary as OSC 7501: idle, working, blocked, error, done(=COMPLETE).
enum { IDLE = 0, WORKING = 1, BLOCKED = 2, ERROR = 3, COMPLETE = 4 };
enum { BK_NONE = 0, BK_PERMISSION = 1, BK_QUESTION = 2, BK_AUTH = 3 };
enum { APP_NONE = 0, APP_SHELL = 1, APP_AGENT = 2, APP_METRICS = 3, APP_REMOTE = 4, APP_NOTE = 5, APP_HERDR = 6 };
enum { VIEW_FOCUS = 0, VIEW_OVERVIEW = 1, VIEW_BACK = 2, VIEW_TIMELINE = 3, VIEW_WORKSPACES = 4 };
enum { NODE_SLOT = 1, NODE_TILE = 2, NODE_GHOST = 3, NODE_LINK = 4, NODE_EVENT = 5, NODE_WORKSPACE = 6 };
enum { FLAG_SELECTED = 1, FLAG_IN_VIEWPORT = 2, FLAG_ACTIVE_WS = 4 };
enum { OP_MOVEFOCUS = 1, OP_WORKSPACE = 2, OP_MOVETOWORKSPACE = 3, OP_KILLACTIVE = 4,
       OP_TOGGLESPECIAL = 5, OP_SWAP = 6, OP_JUMPFOCUS = 7, OP_CYCLEWORKSPACE = 8 };
enum { DIR_LEFT = 0, DIR_RIGHT = 1, DIR_UP = 2, DIR_DOWN = 3 };
enum { EV_SPAWN = 1, EV_CLOSE = 2, EV_PROMOTE = 3, EV_STATUS = 4, EV_WORKSPACE = 5, EV_MOVE = 6, EV_RESET = 7 };

typedef struct {
    int32_t id, kind, status, owner_id, group_id, created_tx, flags, app, progress, blocked_kind;
} Tile;

typedef struct {
    int32_t kind, id, x, y, w, h, status, owner_id, group_id;
    int32_t flags, material_id, shader_id, meta, app, progress;
} Node;

typedef struct { int32_t seq, op, id, a, b; } Event;

static Tile tiles[NWS][CELLS];
static Node nodes[CAPACITY];
static Event events[EVENTS];
static int32_t node_count = 0, event_total = 0;
static int32_t sel_x[NWS], sel_y[NWS], view_x[NWS], view_y[NWS];
static int32_t cur_ws = 0, special_open = 0, next_id = 100, transaction_id = 1;

// -nostdlib: the compiler lowers struct zeroing to memset, so provide it (and stop it recursing).
__attribute__((used, optnone, no_builtin("memset")))
void *memset(void *dst, int c, unsigned long n) {
    unsigned char *p = (unsigned char *)dst;
    while (n--) *p++ = (unsigned char)c;
    return dst;
}

static int32_t bounded(int32_t v, int32_t a, int32_t b) { return v < a ? a : (v > b ? b : v); }
static int32_t idx(int32_t x, int32_t y) { return (x >= 0 && x < SIDE && y >= 0 && y < SIDE) ? (y * SIDE + x) : -1; }
static int32_t active(void) { return special_open ? SPECIAL_WS : cur_ws; }
static int32_t rank(int32_t s) { return s == BLOCKED ? 5 : s == ERROR ? 4 : s == COMPLETE ? 3 : s == WORKING ? 2 : 1; }

static void log_event(int32_t op, int32_t id, int32_t a, int32_t b) {
    Event e = {event_total, op, id, a, b};
    events[event_total % EVENTS] = e;
    event_total++;
}
static void clear_tile(Tile *t) { Tile z = {0}; *t = z; }
static void put(int32_t ws, int32_t x, int32_t y, int32_t id, int32_t kind, int32_t status,
                int32_t owner, int32_t group, int32_t tx, int32_t app) {
    int32_t i = idx(x, y);
    if (i < 0) return;
    Tile t = {id, kind, status, owner, group, tx, 0, app, 0, 0};
    tiles[ws][i] = t;
}
// Minimal viewport shift so the selected slot sits inside the 2x2 focus window.
static void ensure_visible(int32_t ws) {
    int32_t sx = sel_x[ws], sy = sel_y[ws];
    int32_t fx = view_x[ws], fy = view_y[ws];
    // viewport origin must lie in [sel-1, sel]; move it the least amount to get there
    fx = bounded(fx, sx - 1, sx); fy = bounded(fy, sy - 1, sy);
    view_x[ws] = bounded(fx, 0, 4); view_y[ws] = bounded(fy, 0, 4);
}

__attribute__((export_name("kijo_clear")))
void kijo_clear(void) {
    for (int w = 0; w < NWS; w++) {
        for (int i = 0; i < CELLS; i++) clear_tile(&tiles[w][i]);
        sel_x[w] = 2; sel_y[w] = 2; view_x[w] = 1; view_y[w] = 1;
    }
    cur_ws = 0; special_open = 0; node_count = 0; event_total = 0;
    transaction_id = 1; next_id = 100;
}

__attribute__((export_name("kijo_reset")))
void kijo_reset(void) {
    kijo_clear();
    // Workspace 1: one 2x2 reservation (1 visible terminal + 3 owned ghosts) plus three apps.
    put(0,1,1,-1,GHOST,IDLE,1,1,transaction_id,APP_NONE);
    put(0,2,1,-1,GHOST,IDLE,1,1,transaction_id,APP_NONE);
    put(0,1,2,-1,GHOST,IDLE,1,1,transaction_id,APP_NONE);
    put(0,2,2, 1,REAL,IDLE,0,1,transaction_id,APP_SHELL);
    put(0,4,0, 2,REAL,IDLE,0,2,++transaction_id,APP_AGENT);
    put(0,0,4, 3,REAL,IDLE,0,3,++transaction_id,APP_METRICS);
    put(0,5,5, 4,REAL,BLOCKED,0,4,++transaction_id,APP_REMOTE);
    tiles[0][5*SIDE+5].blocked_kind = BK_AUTH;
    // Workspace 2: a bulletin board. Notes need no agent and no connector.
    put(1,1,1, 5,REAL,IDLE,0,5,++transaction_id,APP_NOTE);
    put(1,2,1, 6,REAL,IDLE,0,6,++transaction_id,APP_NOTE);
    put(1,3,2, 7,REAL,IDLE,0,7,++transaction_id,APP_NOTE);
    sel_x[1] = 1; sel_y[1] = 1; view_x[1] = 0; view_y[1] = 0;
    log_event(EV_RESET, 0, 0, 0);
}

__attribute__((export_name("kijo_version"))) int32_t kijo_version(void) { return 2; }
__attribute__((export_name("kijo_tile_ptr"))) int32_t kijo_tile_ptr(void) { return (int32_t)(uintptr_t)&tiles[active()][0]; }
__attribute__((export_name("kijo_ws_tile_ptr"))) int32_t kijo_ws_tile_ptr(int32_t ws) { return (int32_t)(uintptr_t)&tiles[bounded(ws,0,NWS-1)][0]; }
__attribute__((export_name("kijo_tile_count"))) int32_t kijo_tile_count(void) { return CELLS; }
__attribute__((export_name("kijo_workspace_count"))) int32_t kijo_workspace_count(void) { return NWS; }
__attribute__((export_name("kijo_node_ptr"))) int32_t kijo_node_ptr(void) { return (int32_t)(uintptr_t)&nodes[0]; }
__attribute__((export_name("kijo_node_count"))) int32_t kijo_node_count(void) { return node_count; }
__attribute__((export_name("kijo_event_ptr"))) int32_t kijo_event_ptr(void) { return (int32_t)(uintptr_t)&events[0]; }
__attribute__((export_name("kijo_event_total"))) int32_t kijo_event_total(void) { return event_total; }
__attribute__((export_name("kijo_event_capacity"))) int32_t kijo_event_capacity(void) { return EVENTS; }

__attribute__((export_name("kijo_ws"))) int32_t kijo_ws(void) { return cur_ws; }
__attribute__((export_name("kijo_special_open"))) int32_t kijo_special_open(void) { return special_open; }
__attribute__((export_name("kijo_sel_x"))) int32_t kijo_sel_x(void) { return sel_x[active()]; }
__attribute__((export_name("kijo_sel_y"))) int32_t kijo_sel_y(void) { return sel_y[active()]; }
__attribute__((export_name("kijo_focus_x"))) int32_t kijo_focus_x(void) { return view_x[active()]; }
__attribute__((export_name("kijo_focus_y"))) int32_t kijo_focus_y(void) { return view_y[active()]; }
__attribute__((export_name("kijo_at"))) int32_t kijo_at(int32_t x, int32_t y) { return idx(x, y); }

__attribute__((export_name("kijo_select")))
void kijo_select(int32_t x, int32_t y) {
    int32_t w = active();
    sel_x[w] = bounded(x, 0, SIDE - 1); sel_y[w] = bounded(y, 0, SIDE - 1);
    ensure_visible(w);
}

static Tile *selected(void) { return &tiles[active()][sel_y[active()] * SIDE + sel_x[active()]]; }

static Tile *find_real(int32_t id, int32_t *ws_out) {
    for (int w = 0; w < NWS; w++) for (int i = 0; i < CELLS; i++)
        if (tiles[w][i].kind == REAL && tiles[w][i].id == id) { if (ws_out) *ws_out = w; return &tiles[w][i]; }
    return 0;
}

// Footprint spawn at the selected slot. fw x fh slots are reserved; the visible tile takes the
// slot at `corner` (0 tl, 1 tr, 2 bl, 3 br) and the rest become ghosts owned by it.
// Fails (returns 0) unless every reserved slot is empty. Returns the new tile id.
__attribute__((export_name("kijo_spawn")))
int32_t kijo_spawn(int32_t app, int32_t fw, int32_t fh, int32_t corner) {
    int32_t w = active();
    fw = bounded(fw, 1, SIDE); fh = bounded(fh, 1, SIDE);
    if (app < 1 || app > 6) return 0;
    int32_t ox = (corner & 1) ? sel_x[w] - (fw - 1) : sel_x[w];
    int32_t oy = (corner & 2) ? sel_y[w] - (fh - 1) : sel_y[w];
    if (ox < 0 || oy < 0 || ox + fw > SIDE || oy + fh > SIDE) return 0;
    for (int y = 0; y < fh; y++) for (int x = 0; x < fw; x++)
        if (tiles[w][idx(ox + x, oy + y)].kind != EMPTY) return 0;
    int32_t id = next_id++, tx = ++transaction_id;
    for (int y = 0; y < fh; y++) for (int x = 0; x < fw; x++) {
        int32_t gx = ox + x, gy = oy + y;
        if (gx == sel_x[w] && gy == sel_y[w]) put(w, gx, gy, id, REAL, IDLE, 0, id, tx, app);
        else put(w, gx, gy, -1, GHOST, IDLE, id, id, tx, APP_NONE);
    }
    log_event(EV_SPAWN, id, w, app);
    return id;
}

__attribute__((export_name("kijo_promote_ghost")))
int32_t kijo_promote_ghost(int32_t x, int32_t y) {
    int32_t w = active(), i = idx(x, y);
    if (i < 0 || tiles[w][i].kind != GHOST) return 0;
    int32_t new_id = next_id++;
    // Ownership MUST be detached when independently occupied.
    put(w, x, y, new_id, REAL, IDLE, 0, new_id, ++transaction_id, APP_NOTE);
    log_event(EV_PROMOTE, new_id, w, i);
    return new_id;
}

static void cascade(int32_t ws, int32_t id, int32_t group, int32_t tx) {
    // Exact ownership + creation transaction guard. Other tiles are never touched.
    for (int i = 0; i < CELLS; i++) if (tiles[ws][i].kind == GHOST &&
        tiles[ws][i].owner_id == id && tiles[ws][i].group_id == group && tiles[ws][i].created_tx == tx)
        clear_tile(&tiles[ws][i]);
}

__attribute__((export_name("kijo_close")))
int32_t kijo_close(int32_t id) {
    int32_t ws = 0;
    Tile *t = find_real(id, &ws);
    if (!t) return 0;
    int32_t group = t->group_id, tx = t->created_tx;
    clear_tile(t);
    cascade(ws, id, group, tx);
    log_event(EV_CLOSE, id, ws, 0);
    return 1;
}

__attribute__((export_name("kijo_status")))
int32_t kijo_status(int32_t id, int32_t status) {
    if (status < 0 || status > 4) return 0;
    Tile *t = find_real(id, 0);
    if (!t) return 0;
    if (t->status != status) log_event(EV_STATUS, id, t->status, status);
    t->status = status;
    if (status != BLOCKED) t->blocked_kind = BK_NONE;
    if (status != WORKING) t->progress = 0;
    return 1;
}

// OSC 7501 report: state, blocked kind (0..3) and progress (0..100, -1 = unchanged).
__attribute__((export_name("kijo_report")))
int32_t kijo_report(int32_t id, int32_t state, int32_t kind, int32_t progress) {
    if (!kijo_status(id, state)) return 0;
    Tile *t = find_real(id, 0);
    if (state == BLOCKED) t->blocked_kind = bounded(kind, 0, 3);
    if (state == WORKING && progress >= 0) t->progress = bounded(progress, 0, 100);
    return 1;
}

static int32_t move_selection(int32_t dir) {
    int32_t w = active(), nx = sel_x[w], ny = sel_y[w];
    if (dir == DIR_LEFT) nx--; else if (dir == DIR_RIGHT) nx++; else if (dir == DIR_UP) ny--; else if (dir == DIR_DOWN) ny++; else return 0;
    if (idx(nx, ny) < 0) return 0;
    sel_x[w] = nx; sel_y[w] = ny; ensure_visible(w);
    return 1;
}

static int32_t jump_selection(int32_t dir) {
    int32_t w = active(), x = sel_x[w], y = sel_y[w];
    int32_t dx = dir == DIR_LEFT ? -1 : dir == DIR_RIGHT ? 1 : 0, dy = dir == DIR_UP ? -1 : dir == DIR_DOWN ? 1 : 0;
    if (!dx && !dy) return 0;
    for (x += dx, y += dy; idx(x, y) >= 0; x += dx, y += dy)
        if (tiles[w][idx(x, y)].kind == REAL) { sel_x[w] = x; sel_y[w] = y; ensure_visible(w); return 1; }
    return 0;
}

static int32_t first_empty(int32_t ws) {
    for (int i = 0; i < CELLS; i++) if (tiles[ws][i].kind == EMPTY) return i;
    return -1;
}

static int32_t set_workspace(int32_t n) {
    if (n < 0 || n > 8) return 0;
    if (n != cur_ws || special_open) log_event(EV_WORKSPACE, 0, cur_ws, n);
    cur_ws = n; special_open = 0;
    return 1;
}

// Hyprland-style dispatcher. Every host action and every remote IPC command goes through here.
__attribute__((export_name("kijo_dispatch")))
int32_t kijo_dispatch(int32_t op, int32_t a, int32_t b) {
    (void)b;
    int32_t w = active();
    switch (op) {
    case OP_MOVEFOCUS: return move_selection(a);
    case OP_JUMPFOCUS: return jump_selection(a);
    case OP_WORKSPACE: return set_workspace(a);
    case OP_CYCLEWORKSPACE: return set_workspace(((cur_ws + (a < 0 ? -1 : 1)) % 9 + 9) % 9);
    case OP_TOGGLESPECIAL: special_open = !special_open; log_event(EV_WORKSPACE, 0, cur_ws, special_open ? SPECIAL_WS : cur_ws); return 1;
    case OP_KILLACTIVE: { Tile *t = selected(); return t->kind == REAL ? kijo_close(t->id) : 0; }
    case OP_SWAP: {
        int32_t sx = sel_x[w], sy = sel_y[w];
        int32_t nx = sx + (a == DIR_LEFT ? -1 : a == DIR_RIGHT ? 1 : 0), ny = sy + (a == DIR_UP ? -1 : a == DIR_DOWN ? 1 : 0);
        if (idx(nx, ny) < 0 || (nx == sx && ny == sy) || selected()->kind != REAL) return 0;
        Tile tmp = tiles[w][idx(nx, ny)]; tiles[w][idx(nx, ny)] = tiles[w][idx(sx, sy)]; tiles[w][idx(sx, sy)] = tmp;
        sel_x[w] = nx; sel_y[w] = ny; ensure_visible(w);
        log_event(EV_MOVE, tiles[w][idx(nx, ny)].id, w, idx(nx, ny));
        return 1;
    }
    case OP_MOVETOWORKSPACE: {
        Tile *t = selected();
        if (t->kind != REAL || a < 0 || a > 8 || a == w) return 0;
        int32_t slot = first_empty(a);
        if (slot < 0) return 0;
        Tile moved = *t; int32_t id = t->id, group = t->group_id, tx = t->created_tx;
        clear_tile(t); cascade(w, id, group, tx);
        moved.owner_id = 0; moved.group_id = id; moved.created_tx = ++transaction_id;
        tiles[a][slot] = moved;
        log_event(EV_MOVE, id, a, slot);
        return 1;
    }
    }
    return 0;
}

__attribute__((export_name("kijo_restore_tile")))
void kijo_restore_tile(int32_t ws, int32_t index, int32_t id, int32_t kind, int32_t status,
    int32_t owner, int32_t group, int32_t tx, int32_t flags, int32_t app, int32_t progress, int32_t blocked) {
    if (ws < 0 || ws >= NWS || index < 0 || index >= CELLS || kind < 0 || kind > 2) return;
    Tile t = {id, kind, status, owner, group, tx, flags, app, progress, blocked};
    tiles[ws][index] = t;
    if (id >= next_id) next_id = id + 1;
    if (tx >= transaction_id) transaction_id = tx + 1;
}
__attribute__((export_name("kijo_restore_view")))
void kijo_restore_view(int32_t ws, int32_t sx, int32_t sy) {
    if (ws < 0 || ws >= NWS) return;
    sel_x[ws] = bounded(sx, 0, SIDE - 1); sel_y[ws] = bounded(sy, 0, SIDE - 1);
    view_x[ws] = 0; view_y[ws] = 0; ensure_visible(ws);
    view_x[ws] = bounded(sel_x[ws] - 1, 0, 4); view_y[ws] = bounded(sel_y[ws] - 1, 0, 4);
}
__attribute__((export_name("kijo_restore_active")))
void kijo_restore_active(int32_t ws, int32_t special) { cur_ws = bounded(ws, 0, 8); special_open = special ? 1 : 0; }

static void emit(int32_t kind, int32_t id, int32_t x, int32_t y, int32_t w, int32_t h, int32_t status,
                 int32_t owner, int32_t group, int32_t flags, int32_t material, int32_t shader,
                 int32_t meta, int32_t app, int32_t progress) {
    if (node_count >= CAPACITY) return;
    Node n = {kind, id, x, y, w, h, status, owner, group, flags, material, shader, meta, app, progress};
    nodes[node_count++] = n;
}
static int32_t kind_of(Tile t) { return t.kind == REAL ? NODE_TILE : (t.kind == GHOST ? NODE_GHOST : NODE_SLOT); }
static int32_t sel_flag(int32_t ws, int32_t i) { return (sel_y[ws] * SIDE + sel_x[ws]) == i ? FLAG_SELECTED : 0; }

// IMPORTANT: The host does not invent layout. WASM produces a declarative scene.
// Coordinates are in 0..SCALE; render targets decide pixels/glyphs.
__attribute__((export_name("kijo_build_scene")))
int32_t kijo_build_scene(int32_t view) {
    int32_t ws = active();
    node_count = 0;
    if (view == VIEW_FOCUS) {
        for (int ry = 0; ry < 2; ry++) for (int rx = 0; rx < 2; rx++) {
            int32_t i = idx(view_x[ws] + rx, view_y[ws] + ry);
            Tile t = tiles[ws][i];
            emit(kind_of(t), t.id, rx * SCALE / 2, ry * SCALE / 2, SCALE / 2, SCALE / 2, t.status, t.owner_id,
                 t.group_id, t.flags | sel_flag(ws, i), t.kind == GHOST ? 2 : 1, t.status == WORKING ? 1 : 0, i, t.app, t.progress);
        }
    } else if (view == VIEW_OVERVIEW) {
        for (int y = 0; y < SIDE; y++) for (int x = 0; x < SIDE; x++) {
            int32_t i = idx(x, y); Tile t = tiles[ws][i];
            int32_t inview = (x >= view_x[ws] && x < view_x[ws] + 2 && y >= view_y[ws] && y < view_y[ws] + 2) ? FLAG_IN_VIEWPORT : 0;
            emit(kind_of(t), t.id, x * SCALE / SIDE, y * SCALE / SIDE, SCALE / SIDE, SCALE / SIDE, t.status, t.owner_id,
                 t.group_id, t.flags | sel_flag(ws, i) | inview, t.kind == GHOST ? 2 : 1, t.status == WORKING ? 1 : 0, i, t.app, t.progress);
        }
    } else if (view == VIEW_BACK) {
        for (int i = 0; i < CELLS; i++) {
            Tile t = tiles[ws][i];
            int32_t x = (i % SIDE) * SCALE / SIDE, y = (i / SIDE) * SCALE / SIDE;
            if (t.kind == REAL) emit(NODE_TILE, t.id, x, y, SCALE / SIDE, SCALE / SIDE, t.status, 0, t.group_id, sel_flag(ws, i), 3, 0, i, t.app, t.progress);
            if (t.kind == GHOST) emit(NODE_LINK, t.id, x, y, SCALE / SIDE, SCALE / SIDE, t.status, t.owner_id, t.group_id, sel_flag(ws, i), 2, 0, i, t.app, 0);
        }
    } else if (view == VIEW_TIMELINE) {
        int32_t row = 0;
        for (int i = 0; i < CELLS; i++) if (tiles[ws][i].kind == REAL) {
            Tile t = tiles[ws][i];
            emit(NODE_EVENT, t.id, 0, row * 1000, SCALE, 900, t.status, 0, t.group_id, sel_flag(ws, i), 1, 0, i, t.app, t.progress);
            row++;
        }
    } else if (view == VIEW_WORKSPACES) {
        for (int w = 0; w < 9; w++) {
            int32_t reals = 0, ghosts = 0, best = IDLE, prog = 0;
            for (int i = 0; i < CELLS; i++) {
                Tile t = tiles[w][i];
                if (t.kind == REAL) { reals++; if (rank(t.status) > rank(best)) { best = t.status; prog = t.progress; } }
                if (t.kind == GHOST) ghosts++;
            }
            emit(NODE_WORKSPACE, reals, (w % 3) * 2000, (w / 3) * 2000, 2000, 2000, best, 0, ghosts,
                 (w == cur_ws ? FLAG_ACTIVE_WS | FLAG_SELECTED : 0), 1, best == WORKING ? 1 : 0, w, 0, prog);
        }
    }
    return node_count;
}
