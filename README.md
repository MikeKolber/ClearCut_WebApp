<div align="center">

# ClearCut WebApp

**The in-browser engineering suite for ClearCut Space** — three rocket
design and analysis tools, side-by-side, in one place.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-API-000000?logo=flask&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-3D%20viewer-000000?logo=threedotjs&logoColor=white)
![Render](https://img.shields.io/badge/Hosting-Render-46E3B7?logo=render&logoColor=white)
![Access](https://img.shields.io/badge/Access-Internal_%C2%B7_Login_required-B33A3A)

</div>

| Module          | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| **Trajectory**  | 3-DOF flight simulation, ground-track maps, debris dispersion, runs comparison, 3D rocket viewer. |
| **PBS**         | Per-stage mass budgeting across every major rocket subsystem.                    |
| **Engine Test** | TDMS sensor-data analysis and test-fire video review.                            |

---

## Contents

1. [Executive summary & live stats](#executive-summary--live-stats)
2. [Architecture — how it all fits together](#architecture--how-it-all-fits-together)
3. [Getting started](#getting-started)
4. [Running the app](#running-the-app)
5. [Trajectory Simulation](#trajectory-simulation)
6. [PBS — Product Breakdown Structure](#pbs--product-breakdown-structure)
7. [Engine Test](#engine-test)
8. [Where files live](#where-files-live)
9. [Adding files by hand](#adding-files-by-hand)
10. [Keyboard shortcuts](#keyboard-shortcuts)
11. [Troubleshooting](#troubleshooting)
12. [Updating](#updating)
13. [Configuration & deployment](#configuration--deployment)
14. [Project layout](#project-layout)

---

## Executive summary & live stats

**ClearCut WebApp is an internal, browser-based engineering suite** that puts
three rocket-design tools — Trajectory simulation, mass budgeting (PBS), and
engine-test analysis — behind a single company login. There is **nothing for
end users to install**: they open a URL and work. It runs entirely on managed
cloud infrastructure (Render + Cloudflare R2), is always-on (no cold starts),
and is reachable from any modern browser at **`tools.clearcutspace.com`**.

### Deployment at a glance

| Component            | Where it runs                          | Plan / tier                                   |
| -------------------- | -------------------------------------- | --------------------------------------------- |
| **Web frontend**     | Render **Static Site** (global CDN)    | Free                                           |
| **Application API**  | Render **Web Service** (Oregon, US-West) | **Standard** — 2 GB RAM, 1 vCPU, always-on   |
| **Saved-run library**| Render **persistent disk** (`/var/data`) | 1 GB, survives restarts/redeploys            |
| **Engine-test data** | **Cloudflare R2** object storage       | Free tier — 10 GB, zero egress fees           |
| **Est. infra cost**  | —                                      | **≈ $25 / month** ($25 backend + $0 frontend + $0 R2 within free tier) |

### Capacity & limits

| Metric                              | Today's value                                                        |
| ----------------------------------- | -------------------------------------------------------------------- |
| **People who can be logged in**     | Unlimited (browser-cookie sessions; one shared team credential)      |
| **Simultaneous heavy operations**   | **≈ 4** (1 server worker × 4 threads) — extra runs queue briefly     |
| **Target audience**                 | A ~10–30 person engineering department                               |
| **Session length**                  | 12 hours, then re-login                                              |
| **Saved simulation library**        | ~9 full runs (1 GB disk, ≈100 MB each) — prune or grow the disk as needed |
| **Engine-test recordings**          | Up to 10 GB in R2 (multi-GB TDMS + video kept off the app server)    |
| **Server memory / CPU**             | 2 GB RAM / 1 vCPU                                                     |
| **Chart resolution (performance caps)** | Trajectory plots decimated to 10,000 points; TDMS to 20,000 points/channel |
| **Availability**                    | Always-on — no idle sleep / cold starts                              |

### Security & access

- **Authenticated:** every page and API call requires login. Passwords are
  stored only as a **bcrypt hash** (never plaintext), sessions are carried in
  **HTTPS-only signed cookies**, and login is **rate-limited** (5 failed
  attempts per IP per 5 minutes).
- **Isolated:** each browser session gets its own private workspace on the
  server, so two engineers running sims at the same time never clobber each
  other's live output.
- **Today it uses one shared team credential.** If the company wants
  per-person accounts, audit logging, or SSO (Google/Microsoft), that's a
  well-scoped future upgrade — see *Scaling & integration path* below.

### Scaling & integration path

- **Vertical scaling is one dropdown:** bumping the Render plan adds RAM/CPU
  for heavier sims or more concurrent users, with no code changes.
- **Horizontal scaling** (multiple server instances) needs one change first:
  the live-run tracker is currently in-process memory, so it must move to a
  shared store (e.g. Redis) before running more than one worker. This is a
  known, contained piece of work.
- **Portable by design:** the backend is a standard Flask app and storage is
  S3-compatible, so it can move to any cloud (AWS/GCP/Azure) or on-prem
  hardware without a rewrite.

---

## Architecture — how it all fits together

Three layers, one login. The browser never talks to the physics code
directly — everything goes through the authenticated API.

```
        Browser (any device)
   ┌──────────────────────────────┐
   │  React single-page app       │   ← UI, 3D rocket viewer (Three.js),
   │  served from Render CDN       │     interactive plots (Plotly),
   └──────────────┬───────────────┘     maps (deck.gl / MapLibre)
                  │  HTTPS + signed-cookie session
                  ▼
   ┌──────────────────────────────┐
   │  Flask API (gunicorn)         │   ← auth, request routing, progress
   │  Render Web Service, always-on│     tracking, file/session management
   └───────┬───────────────┬───────┘
           │               │
   spawns  │               │  reads/writes
           ▼               ▼
   ┌───────────────┐  ┌───────────────────────────────┐
   │ Physics       │  │ Storage                        │
   │ engines       │  │  • Persistent disk (presets,   │
   │ (Python subs) │  │    saved runs, session output) │
   │  • Trajectory │  │  • Cloudflare R2 (engine-test  │
   │  • PBS        │  │    TDMS + video recordings)     │
   │  • Debris     │  └───────────────────────────────┘
   └───────────────┘
```

**Request flow (example — running a simulation):** the browser posts the
parameters → the API writes them into that session's private workspace and
**launches the trajectory engine as a subprocess** → the API streams progress
back to the browser (the phased progress bar) → when it finishes, results are
saved to disk and the result pages (plots, map, raw data, 3D structure) read
them back. Debris runs chain off a finished trajectory the same way.

**Why a subprocess model?** The heavy scientific code (pandas, scipy, numba,
pyproj, …) runs isolated from the web server, so a long or failed simulation
can't take the API down, and each run is tracked by an id the browser polls.

### Technology stack

| Layer      | Built with                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| Frontend   | React 19, React Router, Three.js (3D), Plotly (charts), deck.gl + MapLibre (maps) |
| Backend    | Python 3.12, Flask, gunicorn, bcrypt (auth), itsdangerous (session cookies) |
| Compute    | The `physics_engines/` package — NumPy, pandas, SciPy, numba, pyproj, nptdms |
| Storage    | Render persistent disk (working data) + Cloudflare R2 / S3 (engine-test archive) |
| Hosting    | Render (backend web service + frontend static site), Cloudflare R2 object storage |

### The three modules in one line each

- **Trajectory** — a 3-DOF flight simulator: give it a vehicle and it produces
  the full ascent (altitude, velocity, Mach, thrust, …), ground-track maps,
  Monte-Carlo debris dispersion, and a 3D model of the rocket it flew.
- **PBS (Product Breakdown Structure)** — a per-stage mass estimator that rolls
  every major subsystem (engine, tanks, TVC, fairing, interstages, …) up into
  dry / propellant / wet mass budgets.
- **Engine Test** — loads test-stand sensor data (TDMS) into interactive plots
  and provides frame-accurate review of test-fire videos.

Full usage for each is documented in the sections below.

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

Open **http://localhost:3000** in your browser.

> **The first screen is a login** — authentication is always on. For local
> development the default credentials are `admin` / `admin` (the backend
> prints a loud warning until you override them). See
> [Configuration & deployment](#configuration--deployment) for how to set a
> real username and password.

After signing in, the landing page shows three module cards plus a status
strip with the backend connection state and current UTC time.

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

## Configuration & deployment

> This section is for whoever runs/operates the app. Day-to-day users can
> skip it.

### Environment variables

The backend is configured entirely through environment variables. Locally,
copy `backend/.env.example` to `backend/.env` and fill it in; in production
they're set in the Render dashboard. With nothing set, the backend boots with
insecure `admin` / `admin` defaults and prints a loud warning.

| Variable                    | Purpose                                                   | Default / notes                              |
| --------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| `CC_USERNAME`               | Login username                                            | `admin` — **override in production**         |
| `CC_PASSWORD_HASH`          | **bcrypt hash** of the password (never the plaintext)     | insecure default — **override in production**|
| `CC_SECRET_KEY`             | Signs the session cookie                                  | random per boot; set a stable value in prod (Render auto-generates one) |
| `CC_SESSION_HOURS`          | Session lifetime before re-login                          | `12`                                         |
| `CC_COOKIE_SECURE`          | Send the cookie over HTTPS only                           | `0` local · `1` production                   |
| `CC_CORS_ORIGINS`           | Comma-separated allow-list of browser origins             | `http://localhost:3000`                      |
| `CC_DATA_DIR`               | Root for presets, saved sims, and per-session workspaces  | repo path locally · `/var/data` on Render    |
| `AWS_EC2_METADATA_DISABLED` | Skip the AWS metadata probe (keeps R2 calls fast on Render) | `true` in production                       |
| `CC_R2_BUCKET`              | Engine-test bucket name — **setting it switches on R2 mode** | unset → read engine tests from local disk |
| `CC_R2_ENDPOINT`            | Cloudflare R2 S3 endpoint URL                             | required when `CC_R2_BUCKET` is set          |
| `CC_R2_ACCESS_KEY_ID`       | R2 access key                                             | required when `CC_R2_BUCKET` is set          |
| `CC_R2_SECRET_ACCESS_KEY`   | R2 secret key                                             | required when `CC_R2_BUCKET` is set          |
| `CC_R2_PREFIX`              | Optional path prefix inside the bucket                    | empty (test folders at bucket root)          |

Generate a password hash with:

```bash
python -c "import bcrypt,getpass; print(bcrypt.hashpw(getpass.getpass('pw: ').encode(), bcrypt.gensalt()).decode())"
```

### How it's deployed

`render.yaml` is a **Render Blueprint** that provisions both services in one
step:

- **`clearcut-backend`** — the Flask API (gunicorn, always-on) with a 1 GB
  persistent disk mounted at `/var/data`.
- **`clearcut-frontend`** — the built React app served as a static site on
  Render's CDN, pointed at the backend via `REACT_APP_API_BASE`.

Sensitive values (`CC_USERNAME`, `CC_PASSWORD_HASH`, the `CC_R2_*` keys, …)
are marked `sync: false` in the blueprint, so Render prompts for them on the
first deploy and never stores them in the repo. Pushing to the `main` branch
triggers an automatic redeploy of both services.

---

## Project layout

For reference, here's what lives where in the repo. You only need to
touch the user-data folders called out in
[Where files live](#where-files-live) — everything else is application
code maintained by the team.

```
ClearCut_WebApp/
├── README.md
├── package.json                       App manifest (frontend deps + scripts)
├── render.yaml                        Render blueprint (backend + frontend services)
├── public/                            Static assets served as-is
│   └── Images/                        Logos, brand artwork
│
├── src/                               Frontend application (React)
│   ├── App.js                         Top-level router
│   ├── index.js                       App entry point
│   ├── setupProxy.js                  Dev-server proxy (/api → backend)
│   ├── assets/                        In-app images / icons
│   ├── components/                    Shared UI (TopBar, NavButton, Tooltip,
│   │                                    Form, ErrorToast, ShortcutsOverlay)
│   ├── pages/
│   │   ├── Login/                     Login screen (auth gate)
│   │   ├── Landing/                   Home screen + module cards
│   │   ├── Trajectory/                Trajectory + Plot / Map / Raw / Compare
│   │   │                                + 3D rocket viewer (rocketScene.js)
│   │   ├── PBS/                       Product Breakdown Structure (+ tabs/)
│   │   └── EngineTest/                Engine Test (Data Analysis + Video)
│   ├── services/                      API client (services/api.js)
│   ├── utils/                         Small shared helpers (download.js)
│   └── styles/                        Global styles / theme
│
├── backend/                           Application server (Flask API)
│   ├── app.py                         Routes, auth, sessions, run tracking
│   ├── engine_test_storage.py         Local-disk / Cloudflare-R2 storage backend
│   ├── requirements.txt               Backend (web/auth) dependencies
│   └── .env.example                   Template for the CC_* environment vars
│
└── physics_engines/                   Calculation engines + user data
    ├── pyproject.toml
    └── core/
        ├── requirements.txt           Scientific-stack dependencies
        │
        ├── Trajectory Simulation/
        │   ├── src/                   Simulation source code
        │   │   └── sketch/            3D-structure generator (desktop origin)
        │   ├── json_files/
        │   │   ├── presets/           ← Trajectory presets (you can add here)
        │   │   ├── debris_presets/    ← Saved debris configurations
        │   │   ├── json_debris/       Working debris params
        │   │   └── _current.json      Working params for the latest run
        │   ├── Pre-loaded Trajectories/   ← Saved sims (you can add here)
        │   ├── output/                The most recent run's CSV (do not edit)
        │   ├── debris_data/           One folder per debris run
        │   ├── data/                  Aero coefficients and reference tables
        │   └── assets/                Textures / flags for the rocket sketch
        │
        ├── PBS/
        │   ├── calculator.py
        │   └── RocketMassCalc/
        │       ├── helpers/           Per-subsystem mass models (+ CEA/)
        │       └── data/
        │           └── initial_parameters.json   ← PBS form defaults
        │
        └── Engine Tests/
            └── data/                  ← Engine test recordings (local-disk mode)
                ├── README.md          Folder convention for new tests
                └── <test name>/       One folder per test (.tdms + videos)
```

Arrows (`←`) mark the folders you might add files to by hand. See
[Where files live](#where-files-live) for what each user-data folder
expects.

> In production, engine-test recordings are served from **Cloudflare R2**
> instead of the local `Engine Tests/data/` folder (see
> [Configuration & deployment](#configuration--deployment)).
