# LAN Fleet Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creating desktop advertise an open fleet over mDNS and let a joining desktop pick it from a live list (or still paste `armada://join?…`).

**Architecture:** Parse/filter/copy live in `desktop-core`. Tauri `discovery.rs` owns mdns-sd register/browse. Join still calls existing `join_fleet`. Hub spawn stays `--lan` regardless of the checkbox.

**Tech Stack:** bun:test, Tauri 2, mdns-sd, existing `desktop-core` join URI helpers.

## Global Constraints

- Service type `_armada._tcp.local.`; TXT keys `ip`, `token`, `ver=1`; SRV port 7380.
- Default checkbox checked (`defaultDiscoverable() === true`).
- Unchecked = no register; `--lan` and paste path unchanged.
- Advertise failure does not fail `create_fleet`.
- Token never in DOM text, toast, or logs.
- Hide advertisements whose TXT `ip` is in local share-candidate IPv4s.
- List cap 32. Browse only while join pane is visible.
- No hub protocol change.

---

### Task 1: desktop-core discovery parser

**Files:**
- Create: `desktop-core/src/discovery.ts`
- Create: `desktop-core/test/discovery.test.ts`
- Modify: `desktop-core/src/index.ts` (re-export)

**Interfaces:**
- Produces: `parseDiscoveryTxt`, `discoveryJoinUri`, `shouldHideOwnFleet`, `discoveredRowView`, `defaultDiscoverable`, `advertiseFailedCopy`, `noOpenFleetsCopy`, `MDNS_SERVICE_TYPE`, `MDNS_TXT_VER`

- [ ] Failing tests in `desktop-core/test/discovery.test.ts` then implement `desktop-core/src/discovery.ts` until `bun test desktop-core/test/discovery.test.ts` passes.

---

### Task 2: Rust TXT helpers + create_fleet discoverable

**Files:**
- Create: `desktop/src-tauri/src/discovery.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (mdns-sd)
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/hub.rs` (`create_fleet(discoverable: bool)`, `CreateFleetResult.advertised`, quit unregisters)

**Interfaces:**
- Consumes: Task 1 key names (`ip`, `token`, `ver`)
- Produces: `txt_pairs(ip, token)`, `should_hide_own(ip, local_ips)`, Tauri events `fleet-found` / `fleet-lost`

- [ ] Unit-test txt pairs and hide-own without multicast. Wire register on create when `discoverable`. `start_fleet_browse` / `stop_fleet_browse`. `cargo test` in `desktop/src-tauri`.

---

### Task 3: Landing UI

**Files:**
- Modify: `desktop/index.html`
- Modify: `desktop/src/styles.css`
- Modify: `desktop/src/main.ts`

- [ ] Checkbox default on. Join pane list + empty copy. Click row → `join_fleet`. Start/stop browse with pane. Toast `advertiseFailedCopy` when create wanted advertise but `advertised` is false.

---

### Task 4: Verify

- [ ] `bun test desktop-core/test`
- [ ] `cargo test` in `desktop/src-tauri`
- [ ] Pack overlay per armada-desktop-packaged-verify
