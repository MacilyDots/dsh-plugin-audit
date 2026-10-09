# dsh-plugin-audit

[English](README.md) | [简体中文](README.zh-CN.md)

Checks whether installed DSH plugins depend on **DSH internals** — dependencies that fail silently after a DSH upgrade: nothing appears in the console, the plugin still loads, but an entire feature is gone.

The typical form is a plugin hard-coding DSH client CSS Module hash class names in its source (`ZTP-Xa_frame`, `nUhMVa_act`, and the like). Every time DSH rebuilds its Web assets the prefixes change as a batch, every hard-coded selector stops matching, and the plugin itself raises no error at all.

## Two tools

| Tool | How it gets data | What it needs |
|---|---|---|
| `audit-asar.mjs` (recommended) | Reads the desktop app's `resources/app.asar` directly | Only a desktop install; DSH does not have to be running and no login is required |
| `audit.mjs` | Pulls the client bundle from a **running DSH** | An authenticated entry point (the gateway state file, or `--base`/`--cookie`) |

The asar holds the same client bundle the kernel serves to the browser (in `window.__ModuleLoader__.load({id, factory})` form), so the offline result is equivalent to the online one.

## audit-asar.mjs

```powershell
node audit-asar.mjs --dump [name]           # Export the real class-name snapshot of the current DSH → snapshots\*.json
node audit-asar.mjs --audit <baseline>      # Audit every profile: which plugins reference class names that "exist in the baseline but are gone now"
node audit-asar.mjs --diff <old snapshot>   # Compare old and new snapshots: vanished class names + old-prefix → new-prefix mapping table
node audit-asar.mjs --check <file>          # Verify whether the class names referenced by a single file still exist
```

The asar location is probed in order: the `DSH_ASAR` environment variable / `--asar <path>`, then the macOS default install location; when neither is found it prints explicit instructions instead of throwing a stack trace.

```powershell
# Explicit: the path is resources/app.asar under the desktop install directory
$env:DSH_ASAR = '<desktop install dir>\resources\app.asar'
# Or specify it per invocation
node audit-asar.mjs --dump --asar '<desktop install dir>\resources\app.asar'
```

The matching rule (stricter than `audit.mjs`, with fewer false positives):

- Only class names that exist in the baseline snapshot, are absent from the current DSH, and are not defined inline by the plugin itself count — CSS Module class names the plugin ships with (its own prefix, unrelated to DSH) are excluded automatically.
- A class name must look like a hash: the prefix contains an uppercase letter, or the whole name contains a digit, or the suffix is camelCase; ordinary identifiers such as `node_modules`, `file_path`, and `read_image` are excluded.

The companion `remap-classes.mjs` covers the repair side:

```powershell
node remap-classes.mjs <old snapshot> <new snapshot> <target file> [--write output.js]
```

It remaps mechanically by **same CSS Module source file + same semantic suffix** (`ZTP-Xa_frame` → `BynINW_frame`), so no manual one-by-one comparison is needed.

> Closing the loop: **`--dump` a snapshot before upgrading** → after upgrading run `--audit <old snapshot>` to find the plugins that were hit → `remap-classes.mjs` generates the remapping → `--check` verifies it.

## audit.mjs (live mode)

```powershell
node audit.mjs                       # Check the desktop profile by default
node audit.mjs web
node audit.mjs desktop --verbose     # Also list plugins with no problems
node audit.mjs desktop --refresh     # Ignore the cache and re-fetch the bundle

# Or specify the entry point explicitly (any authenticated DSH address)
node audit.mjs desktop --base https://192.168.1.10:3443 --cookie "dshmo=<token>"
```

Without `--base` it falls back to reading `$DSH_HOME/mobile-access/state.json` (the state file written once the `dsh-mobile-access` gateway is enabled); if neither is available it fails with an explicit error and suggests switching to `audit-asar.mjs`. The fetched bundle is cached in the system temp directory, so repeated runs do not download it again.

What it checks:

| Item | Description | Consequence when it breaks |
|---|---|---|
| Hard-coded hash class names | Names such as `pI_x6G_frame`, `_bubble_owhem_8` | Every selector stops matching; the related feature disappears silently |
| `[class*="…"]` structural matching | More stable than hard-coding, but still depends on DSH keeping that semantic class name | Same as above, but far less likely |
| Slot names | The `name` passed to `slots.register/inject` | The panel/entry point does not render |
| CSS variables | `--dsw-*` / `--dsh-*` | Styles do not take effect |

## Limitations

- Purely a static comparison: it only covers the class of problems where a plugin references DSH internal identifiers. Runtime behavioral differences and semantic changes in host-side APIs are out of scope.
- Items reported under the slot and CSS variable categories may merely be **optional dependencies between plugins** (one plugin looking for a slot another plugin provides); when the slot is unavailable the plugin takes a degraded path, which is normal design and needs manual confirmation.
- The `[class*="…"]` check skips template literals, overly short generic words, and all-lowercase words to reduce noise.
- `--check` scans every hash-shaped string in a file, so example class names inside documentation comments also count as references; it is aimed at real source such as a plugin's `client.js`.

## Known cases

- `dsh-mobile-hanui`: on 0.1.7, 53 of 64 class names stopped matching (the whole prefix changed from `pI_x6G_*` to `ZTP-Xa_*`); on 0.2.0-rc.2, none of 69 references were valid (the prefix changed again, to `BynINW_*`). Both times the symptom was the same — the plugin loads normally, the floating button does not render, the console shows no error — and the fix only changed the class name constants, leaving the logic untouched.
- Some plugins reference a large number of hash class names, but those come from **their own inline CSS Modules** (their own prefix, unrelated to DSH) and are unaffected by upgrades; the `audit-asar.mjs` rule excludes such false positives automatically.

## After the next DSH upgrade

```powershell
node audit-asar.mjs --audit snapshots\<pre-upgrade snapshot>.json
```

If it reports a batch of "references to class names that are not present in the current DSH", the names were renamed as a batch again; use `--diff` to get the mapping table and repair from there.

## Files

| File | Purpose |
|---|---|
| `audit-asar.mjs` | Offline audit: read app.asar to export snapshots / audit / diff / verify |
| `audit.mjs` | Live audit: pull the bundle from a running DSH and check every installed plugin per profile |
| `remap-classes.mjs` | Generate class name remappings from snapshots (repair side) |
| `snapshots/` | Snapshot output directory (generated locally, not committed) |
