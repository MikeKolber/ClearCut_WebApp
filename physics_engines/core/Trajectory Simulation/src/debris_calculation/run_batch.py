import warnings
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    module=r".*pkg_resources.*",
)
warnings.filterwarnings(
    "ignore",
    message=r".*pkg_resources is deprecated as an API.*",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    module=r"pyatmos\.standardatmos\.coesa76",
)

import os
import sys
import json
from pathlib import Path

# Disable IERS/EOP download and set certs before any pyatmos/astropy imports
os.environ.setdefault("ENABLE_IERS_LOAD", "0")
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except Exception:
    pass


def main():
    # Suppress third-party noisy warnings that break tqdm rendering
    try:
        warnings.filterwarnings(
            "ignore",
            category=UserWarning,
            module="pyatmos.standardatmos.coesa76",
        )
        warnings.filterwarnings(
            "ignore",
            message="pkg_resources is deprecated as an API",
            category=UserWarning,
        )
    except Exception:
        pass
    from debris_calculation.debris_batch import run_debris_batch
    from time import sleep as _sleep

    # Select config: CLI arg > ENV > default
    cfg_path = None
    if len(sys.argv) > 1:
        cfg_path = sys.argv[1]
    if not cfg_path:
        cfg_path = os.environ.get("DEBRIS_CONFIG", "json_files/json_debris/debris_batch.json")

    # Inject a progress file into compute section for a single debris bar
    progress_file = Path(".debris_progress.json").resolve()
    try:
        with open(cfg_path, "r") as f:
            cfg_doc = json.load(f)
        cfg_doc.setdefault("compute", {})["progress_file"] = str(progress_file)
        import tempfile
        tf = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        tmp_cfg = tf.name
        json.dump(cfg_doc, tf)
        tf.flush()
        tf.close()
    except Exception:
        tmp_cfg = cfg_path
        progress_file = None

    # Start a polling loop in a lightweight thread to render tqdm bar
    bar = None
    stop_flag = {"stop": False}

    def _poll():
        nonlocal bar
        try:
            from tqdm import tqdm as _tqdm
        except Exception:
            _tqdm = None
        while not stop_flag["stop"]:
            if progress_file and progress_file.exists() and _tqdm is not None:
                try:
                    with open(progress_file, "r") as pf:
                        doc = json.load(pf)
                    tot = int(doc.get("total_debris", 0))
                    done = int(doc.get("done_debris", 0))
                    if bar is None and tot > 0:
                        bar = _tqdm(total=tot, desc="Debris", unit="deb", dynamic_ncols=True)
                    if bar is not None:
                        if bar.total != tot and tot > 0:
                            bar.total = tot
                        bar.n = min(done, bar.total or done)
                        bar.refresh()
                except Exception:
                    pass
            _sleep(0.3)
        if bar is not None:
            try:
                bar.close()
            except Exception:
                pass

    import threading as _th
    t = _th.Thread(target=_poll, daemon=True)
    t.start()

    try:
        result = run_debris_batch(tmp_cfg)
    finally:
        stop_flag["stop"] = True
        t.join(timeout=2.0)
        try:
            if progress_file and progress_file.exists():
                progress_file.unlink()
        except Exception:
            pass

    print("\n" + "=" * 70)
    print("| Debris Batch Simulation (launcher) |")
    print("=" * 70)
    print(f"Output folder:   {result.get('output_folder')}")
    print(f"Count simulated: {result.get('count')}")
    if result.get("summary_json"):
        print(f"Summary JSON:    {result.get('summary_json')}")
    try:
        html_path = result.get("plots", {}).get("summary_html")
        if html_path:
            print(f"Summary HTML:    {html_path}")
    except Exception:
        pass
    if result.get("plots"):
        print("Plots:")
        for k, v in result["plots"].items():
            if v:
                print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
