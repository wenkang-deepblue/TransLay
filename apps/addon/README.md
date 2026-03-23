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
