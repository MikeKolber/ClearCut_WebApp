# ClearCut WebApp

The in-browser engineering suite for ClearCut Space — three rocket
design and analysis tools, side-by-side, in one place.

| Module                | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| **Trajectory**        | 6-DOF flight simulation, ground-track maps, debris dispersion, runs comparison. |
| **PBS**               | Per-stage mass budgeting across every major rocket subsystem.           |
| **Engine Test**       | TDMS sensor data analysis and test-fire video review.                   |

---

## Contents

1. [Getting started](#getting-started)
2. [Running the app](#running-the-app)
3. [Trajectory Simulation](#trajectory-simulation)
4. [PBS — Product Breakdown Structure](#pbs--product-breakdown-structure)
5. [Engine Test](#engine-test)
6. [Where files live](#where-files-live)
7. [Adding files by hand](#adding-files-by-hand)
8. [Keyboard shortcuts](#keyboard-shortcuts)
9. [Troubleshooting](#troubleshooting)
10. [Updating](#updating)

---

## Getting started

You'll need these installed once per machine:

- **Node.js** — LTS version
- **Python** — 3.10 or newer

From the project root, run:

```bash
# 1) Frontend dependencies
npm install

# 2) Backend + simulation dependencies
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r ../physics_engines/core/requirements.txt
cd ..
```

> **Windows:** activate the virtual environment with
> `.venv\Scripts\activate` instead of `source .venv/bin/activate`.

That's it for setup. The same `.venv` is reused every time you start the
backend — you don't need to recreate it.

---

## Running the app

You need **two terminals** running at the same time.

**Terminal A — backend**

```bash
cd backend
source .venv/bin/activate
python app.py
```

**Terminal B — frontend**

```bash
npm start
```

Open **http://localhost:3000** in your browser. The landing page shows
three module cards plus a status strip with the backend connection
state and current UTC time.

You can leave both terminals running indefinitely. The browser remembers
the last page you were on, so refreshing keeps you in place — useful
when you want to share a deep link like a specific debris run.

---

## Trajectory Simulation

Click **MOD-01** on the landing page, or press `1`.

### Running a simulation

1. Pick a **preset** from the dropdown at the top of the sidebar, or
   leave it on *Custom* and edit from scratch.
2. Adjust parameters in the left sidebar. Section headers expand and
   collapse — click one to reveal its fields.
3. **Per-stage** parameters (engine, propellant, burn time) live under
   the stage chips (`Stage 1` / `Stage 2` / `Stage 3`). Click a chip
   to switch between them.
4. Click **Run Simulation**.

A progress bar tracks the run through three phases: *Initializing →
Simulating → Saving results*. You can cancel any time with the **×**
button next to the bar.

When the run finishes, four result cards appear:

| Card             | View                                                          |
| ---------------- | ------------------------------------------------------------- |
| **Plot Data**    | Stacked interactive charts (height, speed, Mach, thrust, …).  |
| **Debris Analysis** | Sets up and runs a Monte Carlo debris dispersion.          |
| **Raw Data**     | Full spreadsheet view of every channel. CSV / XLSX export.    |
| **Map View**     | 3D globe or flat map with ground track and debris overlays.   |

Plus two utility buttons:

- **View 3D Structure** — open the rocket geometry built by the run in
  an in-app Three.js viewer.
- **Save Simulation** — snapshot the run so you can re-load it later
  or use it as a reference in *Compare*.

### Debris analysis

Click the **Debris Analysis** card after a trajectory run, or switch
the sidebar to the *Debris* tab before clicking Run.

Two modes for choosing failure points:

- **Interval** — sample failure points uniformly across the flight at
  a chosen interval (seconds).
- **Custom** — list specific failure times by hand, one per row.

The run produces, per failure point: an impact CSV, an HTML map, and
aggregate plots that appear automatically in *Map View*.

> Clicking *Run Debris Analysis* before any trajectory has run **in
> this session** triggers a trajectory run first and chains
> automatically into debris when it finishes. You don't have to
> babysit it.

### Loading and comparing runs

| Action                 | What it does                                                   |
| ---------------------- | -------------------------------------------------------------- |
| **Load Simulation**    | Pick a previously-saved run, or upload an external `.csv` / `.xlsx`. |
| **Load Debris**        | Pick from past debris runs.                                    |
| **Compare**            | Overlay any combination of saved runs (and the live run) on the same plot, channel by channel. |
| **Save as Preset**     | Save current parameter set under a chosen name.                |
| **Save Simulation**    | Save the current run's output for re-loading or comparison.    |

In *Compare*, the live run is tagged **LIVE** in the file list to
distinguish it from the saved references.

---

## PBS — Product Breakdown Structure

Click **MOD-02**, or press `2`.

1. Choose **Number of Stages** at the top.
2. Click a stage tab to edit that stage.
3. Walk through the component tabs:

    | Tab              | What it covers                                            |
    | ---------------- | --------------------------------------------------------- |
    | **Engine**       | Mass model, optional CEA performance derivation.          |
    | **TVC**          | Castellini / Rohrschneider / Akin actuator mass models.   |
    | **Thrust**       | Thrust structure mass.                                    |
    | **Propellant**   | Tank sizing (Standard / Castellini / Pablo Rachov).       |
    | **Pressurant**   | Pressurant gas + tank mass, material UTS / safety factor. |
    | **Fairing**      | Cylindrical + frustum + nose shell mass.                  |
    | **PLA**          | Payload Adapter mass.                                     |
    | **Interstages**  | Per-gap interstage mass (one entry per stage gap).        |

4. Click **Calculate**.

Results show:

- Per-stage **dry / propellant / wet** masses.
- A breakdown by component.
- Overall **dry / propellant / wet** totals across all stages.

Export the results as text or CSV from the toolbar. Save and load
working configurations as JSON with **Save Config** / **Load Config**.

---

## Engine Test

Click **MOD-03**, or press `3`.

The sidebar lists every test in
`physics_engines/core/Engine Tests/data/`. Each entry shows the file
counts (e.g. `5D · 2V` = 5 TDMS files, 2 videos). Click a test to
load it on the right.

Two main tools per test:

- **Data Analysis** — opens TDMS channels in an interactive plot view.
  Each channel gets its own panel; pick which channels to show from
  the side panel. *Voltage* and *Current* channels are filtered out,
  matching the standard rig analysis flow.
- **Video Review** — frame-accurate playback of the test-fire videos,
  with scrubbing and per-frame inspection.

Below the two buttons is a file browser listing every recording file
in the selected test folder.

---

## Where files live

Everything the app reads or writes lives under
`physics_engines/core/`. You can drop files in by hand from your file
manager — the app picks them up on the next page load.

| Folder                                                                   | Contents                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `Trajectory Simulation/json_files/presets/`                              | Trajectory parameter presets (`.json`). Filename becomes the preset name. |
| `Trajectory Simulation/Pre-loaded Trajectories/`                         | Saved simulation runs (`.csv` / `.xlsx`). Shown in *Load Simulation* and *Compare*. |
| `Trajectory Simulation/output/`                                          | The most recent run's output. Used by Plot Data, Map View, Raw Data. *Don't edit by hand.* |
| `Trajectory Simulation/debris_data/`                                     | One folder per debris run. Browse via *Load Debris*.                    |
| `PBS/RocketMassCalc/data/initial_parameters.json`                        | Default values used by the PBS form.                                    |
| `Engine Tests/data/<test name>/`                                         | One folder per engine test (`.tdms` + video files). See the README inside that folder. |

---

## Adding files by hand

### A new trajectory preset

Drop a `.json` file into
`physics_engines/core/Trajectory Simulation/json_files/presets/`.
The filename (without `.json`) becomes the preset name in the
sidebar dropdown.

The easiest way to get the right schema is to **open an existing
preset** in that folder and use it as a template.

### A new engine test

Create a folder under `physics_engines/core/Engine Tests/data/`
named after the test, e.g. `2026.05.15 - 8kN trial`. Drop the test's
`.tdms` files and any of `.mp4` / `.avi` / `.mov` / `.mkv` videos
straight into that folder. Refresh the Engine Test page in the
browser — the new test appears at the top of the sidebar list.

### A reference simulation for comparison

Save a run from inside the app (**Save Simulation** on the results
panel), or drop a `.csv` / `.xlsx` directly into
`physics_engines/core/Trajectory Simulation/Pre-loaded Trajectories/`.
It then shows up in both *Load Simulation* and the *Compare* page's
file list.

---

## Keyboard shortcuts

| Key       | Action                                                              |
| --------- | ------------------------------------------------------------------- |
| `1`       | Open Trajectory Simulation (from landing page).                     |
| `2`       | Open PBS (from landing page).                                       |
| `3`       | Open Engine Test (from landing page).                               |
| `Esc`     | Return to the landing page from anywhere in the app.                |

---

## Troubleshooting

**The landing page shows *Backend · Offline***

The backend isn't running, or it crashed. Confirm Terminal A still
shows `Running on http://127.0.0.1:5001` and that no error message
appears. Restart it if needed.

**macOS: the backend starts but the app can't reach it**

macOS *AirPlay Receiver* listens on port 5000 by default. The backend
uses port **5001** specifically to avoid that clash, so things should
work out of the box. If you've manually changed the backend port,
pick anything other than 5000, or disable AirPlay Receiver under
**System Settings → General → AirDrop & Handoff**.

**A result page says *No simulation output yet***

Nothing has run since the backend started in this session. Either run
a simulation, or use **Load Simulation** to load a saved run.

**Clicking *Run Debris Analysis* doesn't immediately show debris**

Debris always needs a finished trajectory in the same session. If
there isn't one, the app runs a trajectory simulation first and then
chains into the debris run — give it a minute, the progress bar will
follow both phases.

**A test folder shows *0D · 0V***

There are no `.tdms` or video files in that folder. The data needs to
be copied in manually — see the README inside `Engine Tests/data/`.

**The plot or map view looks stale after I edited a file on disk**

The result pages cache data per session. After hand-editing a CSV in
`output/` or `Pre-loaded Trajectories/`, restart the backend (Ctrl-C
in Terminal A, then `python app.py` again).

---

## Updating

When the team pushes new code, refresh your local copy:

```bash
git pull
npm install
cd backend && source .venv/bin/activate
pip install -r requirements.txt
pip install -r ../physics_engines/core/requirements.txt
```

Then restart both terminals (Ctrl-C in each, re-run the start
commands). You're current.

---

## Project layout

For reference, here's what lives where in the repo. You only need to
touch the user-data folders called out in
[Where files live](#where-files-live) — everything else is application
code maintained by the team.

```
ClearCut_WebApp/
├── README.md
├── package.json                       App manifest (frontend)
├── public/                            Static assets served as-is
│   └── Images/                        Logos, brand artwork
│
├── src/                               Frontend application
│   ├── App.js                         Top-level router
│   ├── index.js                       App entry point
│   ├── assets/                        In-app images / icons
│   ├── components/                    Shared UI (TopBar, Tooltip, Form, …)
│   ├── pages/
│   │   ├── Landing/                   Home screen + module cards
│   │   ├── Trajectory/                Trajectory + Plot / Map / Raw / Compare
│   │   ├── PBS/                       Product Breakdown Structure
│   │   └── EngineTest/                Engine Test (Data Analysis + Video)
│   ├── services/                      API client
│   ├── styles/                        Global styles / theme
│   └── setupProxy.js                  Dev-server proxy config
│
├── backend/                           Application server
│   ├── app.py
│   └── requirements.txt
│
└── physics_engines/                   Calculation engines + user data
    ├── pyproject.toml
    └── core/
        ├── requirements.txt
        │
        ├── Trajectory Simulation/
        │   ├── src/                   Simulation source code
        │   ├── json_files/
        │   │   ├── presets/           ← Trajectory presets (you can add here)
        │   │   └── _current.json      Working params for the latest run
        │   ├── Pre-loaded Trajectories/   ← Saved sims (you can add here)
        │   ├── output/                The most recent run's CSV (do not edit)
        │   ├── debris_data/           One folder per debris run
        │   ├── data/                  Aero coefficients and reference tables
        │   └── assets/                Textures used by the 3D rocket viewer
        │
        ├── PBS/
        │   ├── calculator.py
        │   └── RocketMassCalc/
        │       ├── helpers/
        │       └── data/
        │           └── initial_parameters.json   ← PBS form defaults
        │
        └── Engine Tests/
            └── data/                  ← Engine test recordings go here
                ├── README.md          Folder convention for new tests
                └── <test name>/       One folder per test (.tdms + videos)
```

Arrows (`←`) mark the folders you might add files to by hand. See
[Where files live](#where-files-live) for what each user-data folder
expects.
