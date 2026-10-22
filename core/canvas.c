// Kijo canvas: the same tiles, ghosts and status as the grid, placed in continuous 2D space.
// Included at the end of scene.c (one translation unit, one wasm module, same ABI rules: i32 in, i32 out).
//
// World units are CSS-pixel-like (a node 260 wide is 260 px at zoom 1) and signed: the canvas is
// unbounded in every direction within +-2^30. The core owns the document (nodes, edges, z-order),
// the view (selection, camera with an eased target, viewport size) and everything that decides what
// is drawn where: culling, screen rectangles and the semantic zoom level of every emitted node.
// Hosts draw the emitted scene and never compute layout.
//
// Canvas ids start at CANVAS_ID0 and never collide with grid ids, so kijo_status / kijo_report /
// kijo_close (and OSC 7501 / injected status) address a canvas tile exactly like a grid tile.

#define CN_CAP 512
#define CE_CAP 512
#define CQ_CAP 512
#define WMAX (1 << 30)
#define Q16 65536
#define Q8 256
#define ZMIN 2048            /* 1/32 */
#define ZMAX (16 * Q16)      /* 16x */
#define ZFLY (2 * Q16)       /* flying to a node never zooms in past 2x */
#define CULL 96              /* px margin outside the viewport that is still emitted */

enum { NODE_VIEWPORT = 7 };
enum { FLAG_LOD_TITLE = 8, FLAG_LOD_FULL = 16, FLAG_LINK_FROM = 32 };
enum { LINK_EDGE = 1, LINK_OWNER = 2 };
enum { ANY_DIR = -1 };

// A canvas node is a Tile (same 10 fields, same meaning) plus a world rectangle.
// Array order is z-order: later entries draw on top.
typedef struct { Tile t; int32_t x, y, w, h; } CNode;
typedef struct { int32_t id, from, to, flags; } CEdge;

static CNode cn[CN_CAP];
static CEdge ce[CE_CAP];
static int32_t cq[CQ_CAP];                       // query results, read through kijo_canvas_qbuf_ptr
static int32_t cn_n = 0, ce_n = 0;
static int32_t c_next = CANVAS_ID0, c_edge_next = 1, c_tx = CANVAS_ID0, c_sel = 0, c_mark = 0, c_fit_pending = 0;
static int32_t vw = 1280, vh = 800;              // viewport in px, set by the host every frame
static int64_t cam_x, cam_y, cam_z;              // camera centre in world*Q8, zoom in Q16
static int64_t cam_tx, cam_ty, cam_tz;           // where the camera is easing to
static int64_t mm_x = 0, mm_y = 0, mm_s = 1;     // last minimap mapping: world origin and span

static int64_t fdiv(int64_t a, int64_t b) { int64_t q = a / b; if ((a % b) != 0 && ((a < 0) != (b < 0))) q--; return q; }
static int64_t rdiv(int64_t a, int64_t b) { return fdiv(a + b / 2, b); }
static int64_t abs64(int64_t v) { return v < 0 ? -v : v; }
static int64_t clamp64(int64_t v, int64_t a, int64_t b) { return v < a ? a : (v > b ? b : v); }
static int32_t px(int64_t v) { return (int32_t)clamp64(v, -WMAX, WMAX); }
static int32_t cfind(int32_t id) { for (int32_t i = 0; i < cn_n; i++) if (cn[i].t.id == id) return i; return -1; }
static int32_t is_group(const CNode *n) { return n->t.kind == REAL && n->t.app == APP_GROUP; }
static Tile *canvas_tile(int32_t id) { int32_t i = cfind(id); return i >= 0 && cn[i].t.kind == REAL ? &cn[i].t : 0; }

// ---- camera math (all integer: the native host runs the same bytes and must agree to the pixel)
static int64_t sx_of(int64_t wx) { return rdiv((wx * Q8 - cam_x) * cam_z, (int64_t)Q8 * Q16) + vw / 2; }
static int64_t sy_of(int64_t wy) { return rdiv((wy * Q8 - cam_y) * cam_z, (int64_t)Q8 * Q16) + vh / 2; }
static int64_t slen(int64_t len) { return rdiv(len * cam_z, Q16); }
static int64_t wq8_x(int64_t sx) { return cam_x + fdiv((sx - vw / 2) * Q16 * Q8, cam_z); }   // screen -> world*Q8
static int64_t wq8_y(int64_t sy) { return cam_y + fdiv((sy - vh / 2) * Q16 * Q8, cam_z); }
static void cam_stop(void) { cam_tx = cam_x; cam_ty = cam_y; cam_tz = cam_z; }
static void cam_target(int64_t x_q8, int64_t y_q8, int64_t z) { cam_tx = x_q8; cam_ty = y_q8; cam_tz = clamp64(z, ZMIN, ZMAX); }
static int64_t fit_zoom(int64_t w, int64_t h, int64_t cap) {
    if (w < 1) w = 1; if (h < 1) h = 1;
    int64_t zx = (int64_t)vw * Q16 * 9 / (w * 10), zy = (int64_t)vh * Q16 * 9 / (h * 10);
    return clamp64(zx < zy ? zx : zy, ZMIN, cap);
}
static void look_rect(int64_t x, int64_t y, int64_t w, int64_t h, int64_t cap, int32_t instant) {
    cam_target((x * 2 + w) * Q8 / 2, (y * 2 + h) * Q8 / 2, fit_zoom(w, h, cap));
    if (instant) { cam_x = cam_tx; cam_y = cam_ty; cam_z = cam_tz; }
}

static void canvas_clear(void) {
    CNode zn = {{0}}; CEdge ze = {0};
    for (int32_t i = 0; i < CN_CAP; i++) cn[i] = zn;
    for (int32_t i = 0; i < CE_CAP; i++) ce[i] = ze;
    cn_n = 0; ce_n = 0; c_next = CANVAS_ID0; c_edge_next = 1; c_tx = CANVAS_ID0; c_sel = 0; c_mark = 0; c_fit_pending = 0;
    cam_x = 0; cam_y = 0; cam_z = Q16; cam_stop();
}

static int32_t c_add(int32_t kind, int32_t app, int32_t x, int32_t y, int32_t w, int32_t h, int32_t owner) {
    if (cn_n >= CN_CAP || app < 0 || app > CANVAS_APP_MAX) return 0;
    CNode n = {{0}};
    int32_t id = c_next++, oi = owner ? cfind(owner) : -1;
    n.t.id = id; n.t.kind = kind; n.t.app = kind == GHOST ? APP_NONE : app; n.t.status = IDLE;
    if (kind == GHOST && oi >= 0) { n.t.owner_id = owner; n.t.group_id = cn[oi].t.group_id; n.t.created_tx = cn[oi].t.created_tx; }
    else { n.t.group_id = id; n.t.created_tx = ++c_tx; }
    n.x = bounded(x, -WMAX, WMAX); n.y = bounded(y, -WMAX, WMAX);
    n.w = bounded(w, 8, 1 << 20); n.h = bounded(h, 8, 1 << 20);
    cn[cn_n++] = n;
    return id;
}

// ---- document: nodes
__attribute__((export_name("kijo_canvas_version"))) int32_t kijo_canvas_version(void) { return 1; }
__attribute__((export_name("kijo_canvas_node_ptr"))) int32_t kijo_canvas_node_ptr(void) { return (int32_t)(uintptr_t)&cn[0]; }
__attribute__((export_name("kijo_canvas_node_count"))) int32_t kijo_canvas_node_count(void) { return cn_n; }
__attribute__((export_name("kijo_canvas_edge_ptr"))) int32_t kijo_canvas_edge_ptr(void) { return (int32_t)(uintptr_t)&ce[0]; }
__attribute__((export_name("kijo_canvas_edge_count"))) int32_t kijo_canvas_edge_count(void) { return ce_n; }
__attribute__((export_name("kijo_canvas_qbuf_ptr"))) int32_t kijo_canvas_qbuf_ptr(void) { return (int32_t)(uintptr_t)&cq[0]; }

// A visible tile of `app` at a world rectangle. Overlap is allowed: placing by hand is free;
// kijo_canvas_free / kijo_canvas_place find room when the caller wants it.
__attribute__((export_name("kijo_canvas_add")))
int32_t kijo_canvas_add(int32_t app, int32_t x, int32_t y, int32_t w, int32_t h) {
    if (app < 1) return 0;
    int32_t id = c_add(REAL, app, x, y, w, h, 0);
    if (id) log_event(EV_SPAWN, id, -1, app);
    return id;
}

// A reservation: space that is taken before its content exists (an agent's next output, a footprint).
// Owned by `owner` when it names a live canvas tile; closing the owner removes exactly the ghosts it
// still owns (same owner + group + creation transaction rule as the grid).
__attribute__((export_name("kijo_canvas_reserve")))
int32_t kijo_canvas_reserve(int32_t owner, int32_t x, int32_t y, int32_t w, int32_t h) {
    int32_t oi = owner ? cfind(owner) : -1;
    if (owner && (oi < 0 || cn[oi].t.kind != REAL)) return 0;
    int32_t id = c_add(GHOST, APP_NONE, x, y, w, h, owner);
    if (id) log_event(EV_SPAWN, id, -1, 0);
    return id;
}

// A reservation becomes a real tile with the same id (so whoever reserved it can keep addressing it).
// Ownership is detached: an independently occupied slot never dies with its former owner.
__attribute__((export_name("kijo_canvas_fill")))
int32_t kijo_canvas_fill(int32_t id, int32_t app) {
    int32_t i = cfind(id);
    if (i < 0 || cn[i].t.kind != GHOST || app < 1 || app > CANVAS_APP_MAX) return 0;
    cn[i].t.kind = REAL; cn[i].t.app = app; cn[i].t.owner_id = 0; cn[i].t.group_id = id; cn[i].t.created_tx = ++c_tx;
    log_event(EV_PROMOTE, id, -1, app);
    return id;
}

static void c_remove_at(int32_t i) {
    int32_t id = cn[i].t.id;
    for (int32_t j = i; j + 1 < cn_n; j++) cn[j] = cn[j + 1];
    cn_n--;
    for (int32_t e = 0; e < ce_n;) {
        if (ce[e].from == id || ce[e].to == id) { for (int32_t j = e; j + 1 < ce_n; j++) ce[j] = ce[j + 1]; ce_n--; }
        else e++;
    }
    if (c_sel == id) c_sel = 0;
    if (c_mark == id) c_mark = 0;
}

__attribute__((export_name("kijo_canvas_close")))
int32_t kijo_canvas_close(int32_t id) {
    int32_t i = cfind(id);
    if (i < 0) return 0;
    Tile t = cn[i].t;
    c_remove_at(i);
    if (t.kind == REAL)   // exact ownership + creation transaction guard, as in the grid's cascade()
        for (int32_t j = 0; j < cn_n;) {
            Tile g = cn[j].t;
            if (g.kind == GHOST && g.owner_id == id && g.group_id == t.group_id && g.created_tx == t.created_tx) c_remove_at(j);
            else j++;
        }
    log_event(EV_CLOSE, id, -1, 0);
    return 1;
}

__attribute__((export_name("kijo_canvas_move")))
int32_t kijo_canvas_move(int32_t id, int32_t x, int32_t y) {
    int32_t i = cfind(id); if (i < 0) return 0;
    cn[i].x = bounded(x, -WMAX, WMAX); cn[i].y = bounded(y, -WMAX, WMAX);
    return 1;
}
__attribute__((export_name("kijo_canvas_resize")))
int32_t kijo_canvas_resize(int32_t id, int32_t w, int32_t h) {
    int32_t i = cfind(id); if (i < 0) return 0;
    cn[i].w = bounded(w, 8, 1 << 20); cn[i].h = bounded(h, 8, 1 << 20);
    return 1;
}
// Bring to the top of the z-order.
__attribute__((export_name("kijo_canvas_raise")))
int32_t kijo_canvas_raise(int32_t id) {
    int32_t i = cfind(id); if (i < 0) return 0;
    CNode n = cn[i];
    for (int32_t j = i; j + 1 < cn_n; j++) cn[j] = cn[j + 1];
    cn[cn_n - 1] = n;
    return 1;
}

// ---- document: edges (JSON Canvas edges; ownership links are derived from ghosts, never stored)
__attribute__((export_name("kijo_canvas_link")))
int32_t kijo_canvas_link(int32_t from, int32_t to) {
    if (from == to || cfind(from) < 0 || cfind(to) < 0 || ce_n >= CE_CAP) return 0;
    for (int32_t e = 0; e < ce_n; e++) if (ce[e].from == from && ce[e].to == to) return ce[e].id;
    CEdge g = {c_edge_next++, from, to, 0};
    ce[ce_n++] = g;
    return g.id;
}
__attribute__((export_name("kijo_canvas_unlink")))
int32_t kijo_canvas_unlink(int32_t edge) {
    for (int32_t e = 0; e < ce_n; e++) if (ce[e].id == edge) { for (int32_t j = e; j + 1 < ce_n; j++) ce[j] = ce[j + 1]; ce_n--; return 1; }
    return 0;
}

// ---- persistence (the host stores what the tables say and hands it back in the same order)
__attribute__((export_name("kijo_canvas_restore_node")))
int32_t kijo_canvas_restore_node(int32_t id, int32_t kind, int32_t status, int32_t owner, int32_t group, int32_t tx,
    int32_t flags, int32_t app, int32_t progress, int32_t blocked, int32_t x, int32_t y, int32_t w, int32_t h) {
    if (cn_n >= CN_CAP || id < CANVAS_ID0 || (kind != REAL && kind != GHOST) || cfind(id) >= 0) return 0;
    CNode n = {{id, kind, bounded(status, 0, 4), owner, group, tx, flags, bounded(app, 0, CANVAS_APP_MAX), bounded(progress, 0, 100), bounded(blocked, 0, 3)},
               bounded(x, -WMAX, WMAX), bounded(y, -WMAX, WMAX), bounded(w, 8, 1 << 20), bounded(h, 8, 1 << 20)};
    cn[cn_n++] = n;
    if (id >= c_next) c_next = id + 1;
    if (tx >= c_tx) c_tx = tx + 1;
    c_fit_pending = 0;
    return 1;
}
__attribute__((export_name("kijo_canvas_restore_edge")))
int32_t kijo_canvas_restore_edge(int32_t id, int32_t from, int32_t to, int32_t flags) {
    if (ce_n >= CE_CAP || id < 1 || from == to || cfind(from) < 0 || cfind(to) < 0) return 0;
    CEdge g = {id, from, to, flags};
    ce[ce_n++] = g;
    if (id >= c_edge_next) c_edge_next = id + 1;
    return 1;
}

// ---- selection and spatial navigation
static void ensure_visible_node(int32_t i) {
    // Minimal camera shift so the node sits inside the viewport (24 px margin); zoom out only if it cannot fit.
    CNode *n = &cn[i]; const int64_t m = 24;
    if (slen(n->w) > vw - 2 * m || slen(n->h) > vh - 2 * m) { look_rect(n->x, n->y, n->w, n->h, cam_z, 0); return; }
    int64_t x0 = sx_of(n->x), y0 = sy_of(n->y), x1 = x0 + slen(n->w), y1 = y0 + slen(n->h), dx = 0, dy = 0;
    if (x0 < m) dx = x0 - m; else if (x1 > vw - m) dx = x1 - (vw - m);
    if (y0 < m) dy = y0 - m; else if (y1 > vh - m) dy = y1 - (vh - m);
    if (dx || dy) cam_target(cam_x + fdiv(dx * Q16 * Q8, cam_z), cam_y + fdiv(dy * Q16 * Q8, cam_z), cam_z);
}

__attribute__((export_name("kijo_canvas_select")))
int32_t kijo_canvas_select(int32_t id) {
    if (id == 0) { c_sel = 0; return 1; }
    int32_t i = cfind(id); if (i < 0) return 0;
    c_sel = id; ensure_visible_node(i);
    return 1;
}
// Pointer selection: no camera movement (the node is already under the pointer).
__attribute__((export_name("kijo_canvas_pick")))
int32_t kijo_canvas_pick(int32_t id) { if (id && cfind(id) < 0) return 0; c_sel = id; return 1; }
__attribute__((export_name("kijo_canvas_sel"))) int32_t kijo_canvas_sel(void) { return c_sel; }
__attribute__((export_name("kijo_canvas_mark"))) int32_t kijo_canvas_mark(int32_t id) { if (id && cfind(id) < 0) return 0; c_mark = id; return 1; }
__attribute__((export_name("kijo_canvas_marked"))) int32_t kijo_canvas_marked(void) { return c_mark; }

// Arrow keys: the best node in that direction from the selection's centre. Candidates inside a
// 90-degree cone win; otherwise anything on that side. Score = distance along + 2x distance across.
// Groups are containers, not stops.
__attribute__((export_name("kijo_canvas_focus")))
int32_t kijo_canvas_focus(int32_t dir) {
    if (dir < DIR_LEFT || dir > DIR_DOWN) return 0;
    int32_t si = c_sel ? cfind(c_sel) : -1;
    int64_t ox = si >= 0 ? (int64_t)cn[si].x * 2 + cn[si].w : fdiv(cam_x * 2, Q8), oy = si >= 0 ? (int64_t)cn[si].y * 2 + cn[si].h : fdiv(cam_y * 2, Q8);
    int32_t best = -1, best_cone = 0; int64_t best_s = 0;
    for (int32_t i = 0; i < cn_n; i++) {
        if (i == si || is_group(&cn[i])) continue;
        int64_t dx = (int64_t)cn[i].x * 2 + cn[i].w - ox, dy = (int64_t)cn[i].y * 2 + cn[i].h - oy;   // doubled centres
        int64_t along = dir == DIR_RIGHT ? dx : dir == DIR_LEFT ? -dx : dir == DIR_DOWN ? dy : -dy;
        int64_t across = abs64(dir == DIR_LEFT || dir == DIR_RIGHT ? dy : dx);
        if (along <= 0) continue;
        int32_t cone = across <= along;
        int64_t s = along + 2 * across;
        if (best < 0 || cone > best_cone || (cone == best_cone && s < best_s)) { best = i; best_cone = cone; best_s = s; }
    }
    if (best < 0) return 0;
    c_sel = cn[best].t.id; ensure_visible_node(best);
    return c_sel;
}

// ---- spatial queries for hosts and agents (results in the query buffer)
static int32_t overlaps(int64_t ax, int64_t ay, int64_t aw, int64_t ah, int64_t bx, int64_t by, int64_t bw, int64_t bh, int64_t gap) {
    return ax < bx + bw + gap && bx < ax + aw + gap && ay < by + bh + gap && by < ay + ah + gap;
}
// Every node whose rectangle intersects the world rectangle.
__attribute__((export_name("kijo_canvas_query")))
int32_t kijo_canvas_query(int32_t x, int32_t y, int32_t w, int32_t h) {
    int32_t k = 0;
    for (int32_t i = 0; i < cn_n && k < CQ_CAP; i++) if (overlaps(x, y, w, h, cn[i].x, cn[i].y, cn[i].w, cn[i].h, 0)) cq[k++] = cn[i].t.id;
    return k;
}
// Nodes lying fully inside node `id` (what a group contains).
__attribute__((export_name("kijo_canvas_contains")))
int32_t kijo_canvas_contains(int32_t id) {
    int32_t gi = cfind(id), k = 0; if (gi < 0) return 0;
    CNode *g = &cn[gi];
    for (int32_t i = 0; i < cn_n && k < CQ_CAP; i++) {
        CNode *n = &cn[i];
        if (i != gi && n->x >= g->x && n->y >= g->y && (int64_t)n->x + n->w <= (int64_t)g->x + g->w && (int64_t)n->y + n->h <= (int64_t)g->y + g->h) cq[k++] = n->t.id;
    }
    return k;
}
// Up to k nodes nearest to node `id` (gap between rectangles, squared), nearest first. Groups excluded.
__attribute__((export_name("kijo_canvas_near")))
int32_t kijo_canvas_near(int32_t id, int32_t k) {
    int32_t si = cfind(id), n = 0; int64_t d[CQ_CAP];
    if (si < 0 || k < 1) return 0;
    if (k > CQ_CAP) k = CQ_CAP;
    CNode *a = &cn[si];
    for (int32_t i = 0; i < cn_n; i++) {
        if (i == si || is_group(&cn[i])) continue;
        CNode *b = &cn[i];
        int64_t gx = (int64_t)b->x - ((int64_t)a->x + a->w), gx2 = (int64_t)a->x - ((int64_t)b->x + b->w);
        int64_t gy = (int64_t)b->y - ((int64_t)a->y + a->h), gy2 = (int64_t)a->y - ((int64_t)b->y + b->h);
        int64_t dx = gx > gx2 ? gx : gx2, dy = gy > gy2 ? gy : gy2;
        if (dx < 0) dx = 0; if (dy < 0) dy = 0;
        int64_t dist = dx * dx + dy * dy;
        // insertion into the sorted top-k
        int32_t at = n < k ? n : k;
        while (at > 0 && d[at - 1] > dist) { if (at < k) { d[at] = d[at - 1]; cq[at] = cq[at - 1]; } at--; }
        if (at < k) { d[at] = dist; cq[at] = b->t.id; if (n < k) n++; }
    }
    return n;
}

// Room for a w x h rectangle next to node `near` (or the camera centre when near is 0), marching in
// `dir` (0 left, 1 right, 2 up, 3 down; -1 tries right, down, left, up) past whatever is in the way,
// keeping `gap` world units from every non-group node. Writes x, y to the query buffer.
static int32_t free_dir(int64_t rx, int64_t ry, int64_t rw, int64_t rh, int32_t dir, int64_t w, int64_t h, int64_t gap) {
    int64_t x = dir == DIR_RIGHT ? rx + rw + gap : dir == DIR_LEFT ? rx - gap - w : rx;
    int64_t y = dir == DIR_DOWN ? ry + rh + gap : dir == DIR_UP ? ry - gap - h : ry;
    for (int32_t step = 0; step <= cn_n; step++) {
        int32_t hit = -1;
        for (int32_t i = 0; i < cn_n && hit < 0; i++)
            if (!is_group(&cn[i]) && overlaps(x, y, w, h, cn[i].x, cn[i].y, cn[i].w, cn[i].h, gap)) hit = i;
        if (hit < 0) {
            if (x < -WMAX || y < -WMAX || x + w > WMAX || y + h > WMAX) return 0;
            cq[0] = (int32_t)x; cq[1] = (int32_t)y; return 1;
        }
        CNode *c = &cn[hit];
        if (dir == DIR_RIGHT) x = (int64_t)c->x + c->w + gap; else if (dir == DIR_LEFT) x = (int64_t)c->x - gap - w;
        else if (dir == DIR_DOWN) y = (int64_t)c->y + c->h + gap; else y = (int64_t)c->y - gap - h;
    }
    return 0;
}
__attribute__((export_name("kijo_canvas_free")))
int32_t kijo_canvas_free(int32_t near, int32_t dir, int32_t w, int32_t h, int32_t gap) {
    int32_t ni = near ? cfind(near) : -1;
    if (near && ni < 0) return 0;
    w = bounded(w, 8, 1 << 20); h = bounded(h, 8, 1 << 20); gap = bounded(gap, 0, 4096);
    int64_t rx, ry, rw, rh;
    if (ni >= 0) { rx = cn[ni].x; ry = cn[ni].y; rw = cn[ni].w; rh = cn[ni].h; }
    else { rx = fdiv(cam_x, Q8) - w / 2; ry = fdiv(cam_y, Q8) - h / 2; rw = 0; rh = 0; if (dir == ANY_DIR || dir == DIR_RIGHT) rx -= gap; }
    static const int32_t order[4] = {DIR_RIGHT, DIR_DOWN, DIR_LEFT, DIR_UP};
    if (dir >= DIR_LEFT && dir <= DIR_DOWN) return free_dir(rx, ry, rw, rh, dir, w, h, gap);
    for (int32_t k = 0; k < 4; k++) if (free_dir(rx, ry, rw, rh, order[k], w, h, gap)) return 1;
    return 0;
}
// Convenience for agents and keys: free spot + add (+ select). Returns the new id.
__attribute__((export_name("kijo_canvas_place")))
int32_t kijo_canvas_place(int32_t app, int32_t near, int32_t dir, int32_t w, int32_t h) {
    if (!kijo_canvas_free(near, dir, w, h, 40)) return 0;
    return kijo_canvas_add(app, cq[0], cq[1], w, h);
}
__attribute__((export_name("kijo_canvas_reserve_near")))
int32_t kijo_canvas_reserve_near(int32_t owner, int32_t near, int32_t dir, int32_t w, int32_t h) {
    if (!kijo_canvas_free(near, dir, w, h, 40)) return 0;
    return kijo_canvas_reserve(owner, cq[0], cq[1], w, h);
}
// Topmost node at a world point; a group only when nothing else is there.
__attribute__((export_name("kijo_canvas_at")))
int32_t kijo_canvas_at(int32_t x, int32_t y) {
    int32_t group = 0;
    for (int32_t i = cn_n - 1; i >= 0; i--) {
        CNode *n = &cn[i];
        if (x >= n->x && y >= n->y && (int64_t)x < (int64_t)n->x + n->w && (int64_t)y < (int64_t)n->y + n->h) {
            if (!is_group(n)) return n->t.id;
            if (!group) group = n->t.id;
        }
    }
    return group;
}
// World bounding box of every node: x, y, w, h in the query buffer. Returns the node count.
static int32_t bounds(int64_t *x0, int64_t *y0, int64_t *x1, int64_t *y1) {
    if (!cn_n) return 0;
    *x0 = cn[0].x; *y0 = cn[0].y; *x1 = (int64_t)cn[0].x + cn[0].w; *y1 = (int64_t)cn[0].y + cn[0].h;
    for (int32_t i = 1; i < cn_n; i++) {
        if (cn[i].x < *x0) *x0 = cn[i].x; if (cn[i].y < *y0) *y0 = cn[i].y;
        if ((int64_t)cn[i].x + cn[i].w > *x1) *x1 = (int64_t)cn[i].x + cn[i].w;
        if ((int64_t)cn[i].y + cn[i].h > *y1) *y1 = (int64_t)cn[i].y + cn[i].h;
    }
    return cn_n;
}
__attribute__((export_name("kijo_canvas_bounds")))
int32_t kijo_canvas_bounds(void) {
    int64_t x0, y0, x1, y1;
    if (!bounds(&x0, &y0, &x1, &y1)) return 0;
    cq[0] = px(x0); cq[1] = px(y0); cq[2] = px(x1 - x0); cq[3] = px(y1 - y0);
    return cn_n;
}

// ---- camera
// The host reports the viewport size every frame. A freshly seeded canvas frames its first group
// the first time a real size arrives.
__attribute__((export_name("kijo_canvas_viewport")))
void kijo_canvas_viewport(int32_t w, int32_t h) {
    vw = bounded(w, 16, 16384); vh = bounded(h, 16, 16384);
    if (c_fit_pending) { int32_t i = cfind(c_fit_pending); c_fit_pending = 0; if (i >= 0) look_rect(cn[i].x, cn[i].y, cn[i].w, cn[i].h, Q16, 1); }
}
// Drag: move the content by a screen delta. Immediate; cancels any flight.
__attribute__((export_name("kijo_canvas_pan")))
void kijo_canvas_pan(int32_t dx, int32_t dy) {
    cam_x -= fdiv((int64_t)dx * Q16 * Q8, cam_z); cam_y -= fdiv((int64_t)dy * Q16 * Q8, cam_z); cam_stop();
}
// Zoom by factor (Q16) keeping the world point under screen (sx, sy) fixed; sx < 0 means the centre.
__attribute__((export_name("kijo_canvas_zoom_at")))
int32_t kijo_canvas_zoom_at(int32_t sx, int32_t sy, int32_t factor) {
    if (sx < 0) { sx = vw / 2; sy = vh / 2; }
    int64_t wx = wq8_x(sx), wy = wq8_y(sy), z = clamp64(rdiv(cam_z * factor, Q16), ZMIN, ZMAX);
    cam_z = z;
    cam_x = wx - fdiv((int64_t)(sx - vw / 2) * Q16 * Q8, z); cam_y = wy - fdiv((int64_t)(sy - vh / 2) * Q16 * Q8, z);
    cam_stop();
    return (int32_t)z;
}
// Ease towards a world centre and zoom (zoom <= 0 keeps the current one).
__attribute__((export_name("kijo_canvas_look")))
void kijo_canvas_look(int32_t x, int32_t y, int32_t zoom, int32_t instant) {
    cam_target((int64_t)x * Q8, (int64_t)y * Q8, zoom > 0 ? zoom : cam_tz);
    if (instant) { cam_x = cam_tx; cam_y = cam_ty; cam_z = cam_tz; }
}
// Enter: frame the node (never closer than 2x). Esc: frame everything (never closer than 1x).
__attribute__((export_name("kijo_canvas_fly")))
int32_t kijo_canvas_fly(int32_t id) {
    int32_t i = cfind(id); if (i < 0) return 0;
    look_rect(cn[i].x, cn[i].y, cn[i].w, cn[i].h, ZFLY, 0);
    return 1;
}
__attribute__((export_name("kijo_canvas_fit")))
int32_t kijo_canvas_fit(void) {
    int64_t x0, y0, x1, y1;
    if (!bounds(&x0, &y0, &x1, &y1)) { cam_target(0, 0, Q16); return 0; }
    look_rect(x0, y0, x1 - x0, y1 - y0, Q16, 0);
    return 1;
}
// Advance the eased camera by dt milliseconds (>= 1000 snaps, 0 only asks). Returns 1 while still moving.
__attribute__((export_name("kijo_canvas_step")))
int32_t kijo_canvas_step(int32_t dt_ms) {
    int64_t f = dt_ms <= 0 ? 0 : dt_ms >= 1000 ? 1024 : (int64_t)dt_ms * 14 * 1024 / (1000 + (int64_t)dt_ms * 14);
    int64_t snap_xy = (int64_t)Q16 * Q8 / (4 * cam_z) + 1, snap_z = cam_z / 2048 + 1, moving = 0;
    int64_t *v[3] = {&cam_x, &cam_y, &cam_z}, t[3] = {cam_tx, cam_ty, cam_tz}, s[3] = {snap_xy, snap_xy, snap_z};
    for (int32_t k = 0; k < 3; k++) {
        int64_t d = t[k] - *v[k];
        if (f == 0) { if (abs64(d) > s[k]) moving = 1; continue; }   // dt 0: a question, not a step
        if (abs64(d) <= s[k] || f >= 1024) { *v[k] = t[k]; continue; }
        int64_t m = d * f / 1024;
        *v[k] += m ? m : (d > 0 ? 1 : -1);
        moving = 1;
    }
    return (int32_t)moving;
}
__attribute__((export_name("kijo_canvas_zoom"))) int32_t kijo_canvas_zoom(void) { return (int32_t)cam_z; }
__attribute__((export_name("kijo_canvas_cam_x"))) int32_t kijo_canvas_cam_x(void) { return px(rdiv(cam_x, Q8)); }
__attribute__((export_name("kijo_canvas_cam_y"))) int32_t kijo_canvas_cam_y(void) { return px(rdiv(cam_y, Q8)); }
__attribute__((export_name("kijo_canvas_to_screen")))
void kijo_canvas_to_screen(int32_t x, int32_t y) { cq[0] = px(sx_of(x)); cq[1] = px(sy_of(y)); }
__attribute__((export_name("kijo_canvas_to_world")))
void kijo_canvas_to_world(int32_t sx, int32_t sy) { cq[0] = px(fdiv(wq8_x(sx), Q8)); cq[1] = px(fdiv(wq8_y(sy), Q8)); }

// ---- scenes
static int32_t lod_flags(int64_t w, int64_t h) {
    if (w >= 180 && h >= 120) return FLAG_LOD_FULL;
    if (w >= 40 && h >= 24) return FLAG_LOD_TITLE;
    return 0;
}
static void emit_cnode(int32_t i) {
    CNode *n = &cn[i];
    int64_t x = sx_of(n->x), y = sy_of(n->y), w = slen(n->w), h = slen(n->h);
    if (x >= vw + CULL || y >= vh + CULL || x + w <= -CULL || y + h <= -CULL) return;
    int32_t lf = lod_flags(w, h), lod = lf == FLAG_LOD_FULL ? 2 : lf ? 1 : 0;
    int32_t fl = n->t.flags | lf | (n->t.id == c_sel ? FLAG_SELECTED : 0) | (n->t.id == c_mark ? FLAG_LINK_FROM : 0);
    emit(n->t.kind == GHOST ? NODE_GHOST : NODE_TILE, n->t.id, px(x), px(y), px(w), px(h), n->t.status, n->t.owner_id,
         n->t.group_id, fl, lod, n->t.status == WORKING ? 1 : 0, i, n->t.app, n->t.progress);
}
static void emit_link(int32_t ai, int32_t bi, int32_t id, int32_t kind) {
    CNode *a = &cn[ai], *b = &cn[bi];
    int64_t ax = sx_of(a->x), ay = sy_of(a->y), aw = slen(a->w), ah = slen(a->h), bx = sx_of(b->x), by = sy_of(b->y), bw = slen(b->w), bh = slen(b->h);
    int64_t x0 = ax < bx ? ax : bx, y0 = ay < by ? ay : by, x1 = ax + aw > bx + bw ? ax + aw : bx + bw, y1 = ay + ah > by + bh ? ay + ah : by + bh;
    if (x0 >= vw + CULL || y0 >= vh + CULL || x1 <= -CULL || y1 <= -CULL) return;
    int32_t fl = (a->t.id == c_sel || b->t.id == c_sel) ? FLAG_SELECTED : 0;
    // x, y = centre of `from`; w, h = centre of `to` (screen px). owner/group carry the two node ids.
    emit(NODE_LINK, id, px(ax + aw / 2), px(ay + ah / 2), px(bx + bw / 2), px(by + bh / 2), 0, a->t.id, b->t.id, fl, kind, 0, -1, 0, 0);
}
static void build_canvas(void) {
    for (int32_t i = 0; i < cn_n; i++) if (is_group(&cn[i])) emit_cnode(i);                  // regions behind everything
    for (int32_t e = 0; e < ce_n; e++) { int32_t a = cfind(ce[e].from), b = cfind(ce[e].to); if (a >= 0 && b >= 0) emit_link(a, b, ce[e].id, LINK_EDGE); }
    for (int32_t i = 0; i < cn_n; i++) if (cn[i].t.kind == GHOST && cn[i].t.owner_id) { int32_t o = cfind(cn[i].t.owner_id); if (o >= 0) emit_link(o, i, cn[i].t.id, LINK_OWNER); }
    for (int32_t i = 0; i < cn_n; i++) if (!is_group(&cn[i])) emit_cnode(i);
}
// Minimap: the whole document plus the camera, mapped into 0..SCALE by the larger side.
// First node (NODE_SLOT) is the content frame (its w, h give the aspect), last is NODE_VIEWPORT.
static void build_minimap(void) {
    int64_t x0 = fdiv(wq8_x(0), Q8), y0 = fdiv(wq8_y(0), Q8), x1 = fdiv(wq8_x(vw), Q8), y1 = fdiv(wq8_y(vh), Q8), nx0, ny0, nx1, ny1;
    int64_t vx0 = x0, vy0 = y0, vx1 = x1, vy1 = y1;
    if (bounds(&nx0, &ny0, &nx1, &ny1)) { if (nx0 < x0) x0 = nx0; if (ny0 < y0) y0 = ny0; if (nx1 > x1) x1 = nx1; if (ny1 > y1) y1 = ny1; }
    int64_t bw = x1 - x0, bh = y1 - y0, s = bw > bh ? bw : bh, pad = s / 20 + 1;
    x0 -= pad; y0 -= pad; bw += 2 * pad; bh += 2 * pad; s += 2 * pad;
    mm_x = x0; mm_y = y0; mm_s = s;
    emit(NODE_SLOT, 0, 0, 0, (int32_t)(bw * SCALE / s), (int32_t)(bh * SCALE / s), 0, 0, 0, 0, 0, 0, -1, 0, 0);
    for (int32_t pass = 0; pass < 2; pass++) for (int32_t i = 0; i < cn_n; i++) {
        CNode *n = &cn[i];
        if (is_group(n) != !pass) continue;
        int32_t w = (int32_t)((int64_t)n->w * SCALE / s), h = (int32_t)((int64_t)n->h * SCALE / s);
        emit(n->t.kind == GHOST ? NODE_GHOST : NODE_TILE, n->t.id, (int32_t)(((int64_t)n->x - x0) * SCALE / s), (int32_t)(((int64_t)n->y - y0) * SCALE / s),
             w < 1 ? 1 : w, h < 1 ? 1 : h, n->t.status, n->t.owner_id, n->t.group_id, n->t.id == c_sel ? FLAG_SELECTED : 0, 0, 0, i, n->t.app, n->t.progress);
    }
    emit(NODE_VIEWPORT, 0, (int32_t)((vx0 - x0) * SCALE / s), (int32_t)((vy0 - y0) * SCALE / s), (int32_t)((vx1 - vx0) * SCALE / s), (int32_t)((vy1 - vy0) * SCALE / s), 0, 0, 0, 0, 0, 0, -1, 0, 0);
}
// Minimap point (0..SCALE units, from the last minimap scene) -> world, in the query buffer.
__attribute__((export_name("kijo_canvas_minimap_to_world")))
void kijo_canvas_minimap_to_world(int32_t mx, int32_t my) { cq[0] = px(mm_x + (int64_t)mx * mm_s / SCALE); cq[1] = px(mm_y + (int64_t)my * mm_s / SCALE); }

// ---- demo document (kijo_reset): a region with notes, an agent that has reserved room for its next
// output, a chart, a log, links between them, and a second region far away.
__attribute__((export_name("kijo_canvas_seed")))
void kijo_canvas_seed(void) {
    canvas_clear();
    int32_t region = c_add(REAL, APP_GROUP, -40, -90, 1500, 640, 0);            // 1000000
    int32_t n1 = c_add(REAL, APP_NOTE, 0, 0, 300, 190, 0);                        // 1000001
    int32_t n2 = c_add(REAL, APP_NOTE, 340, 0, 300, 190, 0);                      // 1000002
    int32_t agent = c_add(REAL, APP_AGENT, 0, 250, 300, 250, 0);                  // 1000003
    c_add(GHOST, APP_NONE, 340, 250, 300, 250, agent);                            // 1000004
    int32_t chart = c_add(REAL, APP_SERIES, 680, 0, 420, 250, 0);                 // 1000005
    c_add(REAL, APP_LOGS, 680, 290, 420, 210, 0);                                 // 1000006
    int32_t n3 = c_add(REAL, APP_NOTE, 1140, 0, 280, 190, 0);                     // 1000007
    c_add(REAL, APP_GROUP, 3160, 1720, 420, 320, 0);                              // 1000008
    c_add(REAL, APP_NOTE, 3220, 1800, 300, 190, 0);                               // 1000009
    cn[cfind(agent)].t.status = WORKING; cn[cfind(agent)].t.progress = 40;
    kijo_canvas_link(n1, n2); kijo_canvas_link(n2, n3); kijo_canvas_link(agent, chart);
    c_sel = n1; c_fit_pending = region;
    look_rect(-40, -90, 1500, 640, Q16, 1);
}
