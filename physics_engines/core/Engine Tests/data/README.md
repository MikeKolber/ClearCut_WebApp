# Engine Test Data

Drop your engine test recordings here, one folder per test:

```
Engine Tests/data/
├── 2026.02.17 - 5kN v4.0/
│   ├── Results_*.tdms
│   ├── Cam_*.mp4
│   └── vid_*.mp4
├── 2026.05.15 - 8kN trial/
│   └── ...
└── <next test name>/
    └── ...
```

Each test folder can contain:

- `.tdms` files — sensor recordings. Appear in the **Data Analysis** view.
- `.mp4`, `.avi`, `.mov`, `.mkv` files — appear in the **Video Review** view.

The app's *Engine Test* page scans this directory automatically. Add a
folder, refresh the page, and the new test appears in the sidebar list
with its file counts.

> Recording files (`.tdms`, `.mp4`, …) are not committed to git — they
> are typically hundreds of MB to a few GB per test. On a fresh clone
> this folder is empty; copy the data in by hand or pull it from your
> team's shared storage.
