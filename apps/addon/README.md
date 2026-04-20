# TransLay Add-on

Google Workspace™ Add-on for TransLay. Uses Apps Script + HTML Service.

## Structure

```
apps/addon/
├── appsscript.json          # Apps Script manifest
├── src/
│   ├── server/              # Server-side .gs files
│   │   ├── main.gs          # Entry points (onOpen, showSidebar)
│   │   ├── auth.gs          # Google token acquisition
│   │   ├── api_client.gs    # HTTP calls to control plane
│   │   ├── host_context.gs  # Host type detection, document info
│   │   └── constants.gs     # API URL, preset languages
│   └── sidebar/
│       └── index.html       # Sidebar UI (HTML + inline JS/CSS)
```

## Deployment

```bash
cd apps/addon
clasp push
```

## Logo Sync

To regenerate inline logo code from `assets/TransLay-logo_48px.svg`:

```bash
cd apps/addon
python3 scripts/sync_logo_svg.py
```

Optional overrides:

```bash
cd apps/addon
python3 scripts/sync_logo_svg.py --input assets/TransLay-logo_48px.svg --output src/server/assets.gs
```

To regenerate and push to Apps Script in one command:

```bash
cd apps/addon
python3 scripts/sync_logo_svg.py --push
```
