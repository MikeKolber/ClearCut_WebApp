"""Generate a scaled technical drawing of the rocket structure.

Reads geometry and mass data from a StaticMomentOfInertia instance and
writes rocket_structure.png / .pdf into the same directory as this file.

The drawing logic is separated into ``draw_sketch(ax, sd)`` so the GUI
can render live into its own canvas without going through a raster image.
"""

import os
from pathlib import Path
import json

import numpy as np
import matplotlib
if os.environ.get("CC_OUTPUT_DIR"):
    # Web/server mode — headless, no display. Select the non-GUI backend
    # before pyplot is imported or matplotlib may try (and fail) to open
    # a window on the server.
    matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches

# ──────────────────────────────────────────────────────────────────────
#  Visual constants
# ──────────────────────────────────────────────────────────────────────

COLORS = {
    'engine':     'darkred',
    'fuel':       'orange',
    'oxidizer':   'lightblue',
    'wall':       'gray',
    'tank_head':  'lightgrey',
    'interstage': 'yellow',
    'payload':    'green',
    'fairing':    'lightgray',
}

ENGINE_W  = 0.8
TANK_W    = 0.95
EDGE_W    = 0.1
WALL_W    = 0.05
S3_GAP    = 0.1
LABEL_X   = -1.3
TOTAL_X   = 1.3
TOTAL_TX  = 1.4

SKETCH_DIR = Path(__file__).resolve().parent


def _output_dir() -> Path:
    """Where sketch artefacts (png / pdf / rocket_data.json) are written.

    The web backend sets CC_OUTPUT_DIR to the calling session's private
    workspace so concurrent users never overwrite each other's rocket
    geometry. The desktop flow (no env var) keeps writing next to this
    file, exactly as before."""
    override = os.environ.get("CC_OUTPUT_DIR")
    return Path(override) if override else SKETCH_DIR


# ──────────────────────────────────────────────────────────────────────
#  Helpers
# ──────────────────────────────────────────────────────────────────────

def _annotate_dim(ax, x, y_bot, y_top, *,
                  color='black', lw=1, fontsize=7, x_text_offset=0.1,
                  ha='left', fmt='.2f', prefix='', rotation=0):
    ax.annotate('', xy=(x, y_bot), xytext=(x, y_top),
                arrowprops=dict(arrowstyle='<->', color=color, lw=lw))
    ax.text(x + x_text_offset, (y_bot + y_top) / 2,
            f'{prefix}{y_top - y_bot:{fmt}}m',
            ha=ha, va='center', fontsize=fontsize, color=color,
            fontweight='bold' if lw >= 2 else 'normal',
            rotation=rotation)


def _draw_hemi_edges(ax, radius, inner_r, y_base, h, scale,
                     ranges, zorder=None):
    kw = dict(color='gray', alpha=0.7)
    if zorder is not None:
        kw['zorder'] = zorder
    for t0, t1 in ranges:
        theta = np.linspace(t0, t1, 20)
        x_o = radius * np.cos(theta)
        y_o = y_base + h * np.sin(theta)
        x_i = inner_r * np.cos(theta)
        y_i = y_base + scale * h * np.sin(theta)
        ax.fill(np.concatenate([x_o, x_i[::-1]]),
                np.concatenate([y_o, y_i[::-1]]), **kw)


# ──────────────────────────────────────────────────────────────────────
#  Tank drawing
# ──────────────────────────────────────────────────────────────────────

def _draw_sphere_tank(ax, center_y, radius, edge_w, color,
                      label, mass, annot_x, length_label):
    ax.add_patch(patches.Circle(
        (0, center_y), radius,
        facecolor=COLORS['wall'], edgecolor='black', linewidth=1))
    ax.add_patch(patches.Circle(
        (0, center_y), radius - edge_w,
        facecolor=color, edgecolor='none'))
    r_inner = radius - edge_w
    theta = np.linspace(0, 2 * np.pi, 100)
    ax.plot(r_inner * np.cos(theta),
            center_y + r_inner * np.sin(theta),
            'k--', linewidth=1.5, alpha=0.6)
    ax.text(0, center_y, f'{label}\n{mass:.0f} kg',
            ha='center', va='center', fontsize=8)
    _annotate_dim(ax, annot_x,
                  center_y - radius, center_y + radius, fmt='.3f')


def _draw_cylinder_tank(ax, start_y, length, radius, edge_w,
                        color, label, mass, annot_x):
    tw = radius * TANK_W
    inner_edge = tw - edge_w
    ax.add_patch(patches.Rectangle(
        (-tw, start_y), tw * 2, length,
        facecolor=color, edgecolor='black', linewidth=1))
    for sign in (-1, 1):
        x0 = sign * tw if sign < 0 else tw - edge_w
        ax.add_patch(patches.Rectangle(
            (x0, start_y), edge_w, length,
            facecolor=COLORS['wall'], alpha=0.7))
    for sign in (-1, 1):
        ax.plot([sign * inner_edge, sign * inner_edge],
                [start_y, start_y + length],
                'k--', linewidth=1.5, alpha=0.6)
    ax.text(0, start_y + length / 2, f'{label}\n{mass:.0f} kg',
            ha='center', va='center', fontsize=8)
    _annotate_dim(ax, annot_x, start_y, start_y + length, fmt='.3f')


# ──────────────────────────────────────────────────────────────────────
#  Hemisphere drawing
# ──────────────────────────────────────────────────────────────────────

def _draw_hemisphere_up(ax, y, radius, h, inner_r, edge_w, fill_color):
    theta = np.linspace(0, np.pi, 100)
    x_out = radius * np.cos(theta)
    y_out = y + h * np.sin(theta)
    ax.fill(x_out, y_out, color=COLORS['tank_head'], edgecolor='black',
            linewidth=1, closed=False)
    ax.plot(x_out, y_out, color='black', linewidth=1)

    scale = inner_r / radius
    _draw_hemi_edges(ax, radius, inner_r, y, h, scale,
                     [(np.pi * 0.9, np.pi), (0, np.pi * 0.1)])

    if fill_color:
        x_in = inner_r * np.cos(theta)
        y_in = y + scale * h * np.sin(theta)
        ax.fill(np.append(x_in, x_in[0]),
                np.append(y_in, y), color=fill_color, alpha=1.0)
        theta_d = np.linspace(0, np.pi, 50)
        ax.plot(inner_r * np.cos(theta_d),
                y + scale * h * np.sin(theta_d),
                'k--', linewidth=1.5, alpha=0.6)


def _draw_hemisphere_down(ax, y, radius, h, inner_r, edge_w, tw,
                          fill_color, is_common_bulkhead):
    theta = np.linspace(np.pi, 2 * np.pi, 100)
    x_out = radius * np.cos(theta)
    y_out = y + h + h * np.sin(theta)
    scale = inner_r / radius

    if is_common_bulkhead:
        ax.add_patch(patches.Rectangle(
            (-tw, y), tw * 2, h,
            facecolor=COLORS['fuel'], edgecolor='none', zorder=1))
        for sign in (-1, 1):
            x0 = -tw if sign < 0 else tw - edge_w
            ax.add_patch(patches.Rectangle(
                (x0, y), edge_w, h,
                facecolor=COLORS['wall'], alpha=0.7, zorder=2))
        for sign in (-1, 1):
            ax.plot([sign * (tw - edge_w), sign * (tw - edge_w)],
                    [y, y + h], 'k--', linewidth=1.5, alpha=0.6, zorder=3)

    ax.fill(x_out, y_out, color=COLORS['tank_head'], edgecolor='none',
            zorder=4)
    ax.plot(x_out, y_out, color='black', linewidth=1, zorder=5)

    _draw_hemi_edges(ax, radius, inner_r, y + h, h, scale,
                     [(np.pi, np.pi * 1.1),
                      (2 * np.pi * 0.9, 2 * np.pi)], zorder=6)

    if fill_color:
        x_in = inner_r * np.cos(theta)
        y_in = y + h + scale * h * np.sin(theta)
        ax.fill(np.append(x_in, x_in[0]),
                np.append(y_in, y + h),
                color=fill_color, alpha=1.0, zorder=7)
        theta_d = np.linspace(np.pi, 2 * np.pi, 50)
        ax.plot(inner_r * np.cos(theta_d),
                y + h + scale * h * np.sin(theta_d),
                'k--', linewidth=1.5, alpha=0.6, zorder=8)


def _draw_tank_head(ax, bottom_y, radius, height,
                    direction='up', fill_color=None,
                    is_common_bulkhead=False):
    edge_w = radius * EDGE_W
    tw = radius * TANK_W
    inner_r = tw - edge_w
    if direction == 'up':
        _draw_hemisphere_up(ax, bottom_y, radius, height,
                            inner_r, edge_w, fill_color)
    else:
        _draw_hemisphere_down(ax, bottom_y, radius, height,
                              inner_r, edge_w, tw, fill_color,
                              is_common_bulkhead)


# ──────────────────────────────────────────────────────────────────────
#  Structural elements
# ──────────────────────────────────────────────────────────────────────

def _draw_walls(ax, y_bot, y_top, radius):
    h = y_top - y_bot
    w = radius * WALL_W
    for x0 in (-radius, radius - w):
        ax.add_patch(patches.Rectangle(
            (x0, y_bot), w, h,
            facecolor=COLORS['wall'], edgecolor='black', linewidth=0.5))


def _draw_interstage(ax, name, bottom_y, height,
                     bottom_radius, top_radius, mass=None):
    verts = [(-bottom_radius, bottom_y), (bottom_radius, bottom_y),
             (top_radius, bottom_y + height),
             (-top_radius, bottom_y + height),
             (-bottom_radius, bottom_y)]
    ax.add_patch(patches.Polygon(
        verts, facecolor=COLORS['interstage'],
        edgecolor='black', linewidth=1))
    label = f'Interstage {name}'
    if mass is not None:
        label += f'\n{mass:.0f} kg'
    ax.text(0, bottom_y + height / 2, label,
            ha='center', va='center', fontsize=8)


def _draw_payload(ax, bottom_y, radius, length, mass):
    ax.add_patch(patches.Rectangle(
        (-radius, bottom_y), radius * 2, length,
        facecolor=COLORS['payload'], edgecolor='black', linewidth=1))
    ax.text(0, bottom_y + length / 2,
            f'Payload\n{mass:.0f} kg',
            ha='center', va='center', fontsize=8, color='white')


def _draw_fairing(ax, bottom_y, fairing_radius, payload_radius, length):
    r_top = payload_radius * 0.8
    top_y = bottom_y + length
    verts = [(-fairing_radius, bottom_y), (fairing_radius, bottom_y),
             (r_top, top_y), (-r_top, top_y), (-fairing_radius, bottom_y)]
    ax.add_patch(patches.Polygon(
        verts, facecolor=COLORS['fairing'], alpha=0.3,
        edgecolor='black', linewidth=1, linestyle='--'))


# ──────────────────────────────────────────────────────────────────────
#  Stage assembly
# ──────────────────────────────────────────────────────────────────────

def _draw_stage3_tanks(ax, y, radius, edge_w, annot_x,
                       fuel_len, ox_len, fuel_mass, ox_mass,
                       engine_bottom):
    gap = S3_GAP
    y += gap
    _draw_sphere_tank(ax, y + radius, radius, edge_w,
                      COLORS['fuel'], 'Fuel', fuel_mass,
                      annot_x, f'{fuel_len:.3f}')
    y += radius * 2 + gap
    _draw_sphere_tank(ax, y + radius, radius, edge_w,
                      COLORS['oxidizer'], 'Oxidizer', ox_mass,
                      annot_x, f'{ox_len:.3f}')
    y += radius * 2
    _draw_walls(ax, engine_bottom, y, radius)
    return y


def _draw_stage12_tanks(ax, y, radius, edge_w, annot_x, head_len,
                        fuel_len, ox_len, fuel_mass, ox_mass,
                        engine_bottom):
    _draw_tank_head(ax, y, radius, head_len, 'down',
                    fill_color=COLORS['fuel'])
    _annotate_dim(ax, annot_x, y, y + head_len)
    y += head_len

    _draw_cylinder_tank(ax, y, fuel_len, radius, edge_w,
                        COLORS['fuel'], 'Fuel', fuel_mass, annot_x)
    y += fuel_len

    _draw_tank_head(ax, y, radius, head_len, 'down',
                    fill_color=COLORS['oxidizer'], is_common_bulkhead=True)
    _annotate_dim(ax, annot_x + 0.5, y, y + head_len,
                  color='darkblue', fontsize=6,
                  x_text_offset=0.1, prefix='CB: ')
    y += head_len

    _draw_cylinder_tank(ax, y, ox_len, radius, edge_w,
                        COLORS['oxidizer'], 'Oxidizer', ox_mass, annot_x)
    y += ox_len

    _draw_tank_head(ax, y, radius, head_len, 'up',
                    fill_color=COLORS['oxidizer'])
    _annotate_dim(ax, annot_x, y, y + head_len)

    top = y + head_len
    _draw_walls(ax, engine_bottom, top, radius)
    return top


def _draw_stage(ax, sd, stage_num, bottom_y):
    """Draw a complete stage and return the top y coordinate.

    Parameters
    ----------
    sd : StaticMomentOfInertia or SimpleNamespace
        The data object to read geometry/mass from.
    """
    radius   = getattr(sd, f'stage{stage_num}_radius')
    eng_len  = getattr(sd, f'stage{stage_num}_engine_length')
    fuel_len = getattr(sd, f'stage{stage_num}_bottom_propellant_length')
    ox_len   = getattr(sd, f'stage{stage_num}_top_propellant_length')
    head_len = getattr(sd, f'stage{stage_num}_tank_head_length')
    fuel_mass = getattr(sd, f'stage{stage_num}_bottom_propellant_mass')
    ox_mass  = getattr(sd, f'stage{stage_num}_top_propellant_mass')

    edge_w = radius * EDGE_W
    annot_x = radius + 0.3
    current_y = bottom_y
    engine_bottom = current_y

    ax.add_patch(patches.Rectangle(
        (-radius * ENGINE_W, current_y),
        radius * ENGINE_W * 2, eng_len,
        facecolor=COLORS['engine'], edgecolor='black', linewidth=1))
    ax.text(0, current_y + eng_len / 2, f'S{stage_num} Engine',
            ha='center', va='center', fontsize=8, color='white')
    _annotate_dim(ax, annot_x, current_y, current_y + eng_len)
    current_y += eng_len

    if stage_num == 3:
        top = _draw_stage3_tanks(
            ax, current_y, radius, edge_w, annot_x,
            fuel_len, ox_len, fuel_mass, ox_mass, engine_bottom)
    else:
        top = _draw_stage12_tanks(
            ax, current_y, radius, edge_w, annot_x, head_len,
            fuel_len, ox_len, fuel_mass, ox_mass, engine_bottom)

    stage_height = getattr(sd, f'stage{stage_num}_length')
    ax.text(radius * LABEL_X, bottom_y + stage_height / 2,
            f'Stage {stage_num}', rotation=90, ha='center', va='center',
            fontsize=12, fontweight='bold')

    _annotate_dim(ax, annot_x + TOTAL_X, engine_bottom, top,
                  color='red', lw=2, fontsize=8,
                  x_text_offset=TOTAL_TX - TOTAL_X,
                  prefix='Total: ', fmt='.3f', rotation=90)

    return top


# ──────────────────────────────────────────────────────────────────────
#  Attribute list for JSON serialisation
# ──────────────────────────────────────────────────────────────────────

_SKETCH_ATTRS = [
    'payload_length', 'payload_radius', 'payload_mass',
    'fairing_radius', 'fairing_length',
    'stage12_interstage_length', 'stage12_interstage_mass',
    'stage23_interstage_length', 'stage23_interstage_mass',
] + [
    f'stage{n}_{a}'
    for n in (1, 2, 3)
    for a in ('radius', 'length', 'engine_length',
              'bottom_propellant_length', 'top_propellant_length',
              'tank_head_length',
              'bottom_propellant_mass', 'top_propellant_mass')
]


# ──────────────────────────────────────────────────────────────────────
#  Horizontal-drawing proxy (transposes x ↔ y)
# ──────────────────────────────────────────────────────────────────────

class _HorizontalProxy:
    """Thin wrapper around a matplotlib Axes that swaps every (x, y)
    so the rocket is drawn on its side (engine on left, nose on right).

    All helper functions remain untouched -- this proxy silently
    transposes coordinates, patch geometry, and text rotation.
    """

    def __init__(self, ax):
        self._ax = ax

    def __getattr__(self, name):
        return getattr(self._ax, name)

    # -- axis limits / labels --
    def set_xlim(self, *a, **kw):   return self._ax.set_ylim(*a, **kw)
    def set_ylim(self, *a, **kw):   return self._ax.set_xlim(*a, **kw)
    def get_xlim(self):             return self._ax.get_ylim()
    def get_ylim(self):             return self._ax.get_xlim()
    def set_xlabel(self, *a, **kw): return self._ax.set_ylabel(*a, **kw)
    def set_ylabel(self, *a, **kw): return self._ax.set_xlabel(*a, **kw)

    # -- patches --
    def add_patch(self, p):
        if isinstance(p, patches.Rectangle) and not isinstance(p, patches.FancyBboxPatch):
            x, y = p.get_xy()
            w, h = p.get_width(), p.get_height()
            p.set_xy((y, x))
            p.set_width(h)
            p.set_height(w)
        elif isinstance(p, patches.Circle):
            cx, cy = p.center
            p.center = (cy, cx)
        elif isinstance(p, patches.Polygon):
            xy = np.asarray(p.get_xy())
            p.set_xy(xy[:, [1, 0]])
        return self._ax.add_patch(p)

    # -- coordinate drawing --
    def fill(self, *args, **kw):
        return self._ax.fill(args[1], args[0], *args[2:], **kw)

    def plot(self, *args, **kw):
        return self._ax.plot(args[1], args[0], *args[2:], **kw)

    def text(self, x, y, s, **kw):
        r = kw.get('rotation', 0)
        kw['rotation'] = 0 if r == 90 else r
        return self._ax.text(y, x, s, **kw)

    def annotate(self, text, **kw):
        if 'xy' in kw:
            a, b = kw['xy'];     kw['xy'] = (b, a)
        if 'xytext' in kw:
            a, b = kw['xytext']; kw['xytext'] = (b, a)
        return self._ax.annotate(text, **kw)


# ──────────────────────────────────────────────────────────────────────
#  Public drawing function (used by both file export and live GUI)
# ──────────────────────────────────────────────────────────────────────

def draw_sketch(ax, sd, horizontal=False):
    """Draw the full rocket diagram into *ax*.

    *sd* can be a ``StaticMomentOfInertia`` instance **or** any object
    whose attributes match the geometry/mass names (e.g. a
    ``types.SimpleNamespace`` loaded from ``rocket_data.json``).

    If *horizontal* is True the rocket is drawn on its side (engine left,
    nose right) which fits landscape screens much better.
    """
    if horizontal:
        ax = _HorizontalProxy(ax)
    total_height = (sd.payload_length + sd.stage3_length +
                    sd.stage23_interstage_length + sd.stage2_length +
                    sd.stage12_interstage_length + sd.stage1_length)
    stage3_start_est = (sd.stage1_length + sd.stage12_interstage_length +
                        sd.stage2_length + sd.stage23_interstage_length)
    fairing_top_est = (stage3_start_est + sd.stage3_engine_length +
                       S3_GAP + sd.fairing_length)
    max_height = max(total_height, fairing_top_est)

    ax.set_xlim(-3.5, 5)
    ax.set_ylim(-3, max_height + 8)
    ax.set_aspect('equal')
    ax.grid(True, alpha=0.3)
    ax.set_xlabel('Radius (m)', fontsize=10)
    ax.set_ylabel('Height from bottom (m)', fontsize=10)
    ax.set_title('Rocket Structure Diagram', fontsize=16,
                 fontweight='bold', pad=40)

    current_y = 0

    current_y = _draw_stage(ax, sd, 1, current_y)

    is_start = current_y
    _draw_interstage(ax, "1-2", current_y,
                     sd.stage12_interstage_length,
                     sd.stage1_radius, sd.stage2_radius,
                     sd.stage12_interstage_mass)
    _annotate_dim(ax, max(sd.stage1_radius, sd.stage2_radius) + 0.3,
                  is_start, is_start + sd.stage12_interstage_length)
    current_y += sd.stage12_interstage_length

    current_y = _draw_stage(ax, sd, 2, current_y)

    is_start = current_y
    _draw_interstage(ax, "2-3", current_y,
                     sd.stage23_interstage_length,
                     sd.stage2_radius, sd.stage3_radius,
                     sd.stage23_interstage_mass)
    _annotate_dim(ax, max(sd.stage2_radius, sd.stage3_radius) + 0.3,
                  is_start, is_start + sd.stage23_interstage_length)
    current_y += sd.stage23_interstage_length

    stage3_y = current_y
    current_y = _draw_stage(ax, sd, 3, current_y)

    _draw_payload(ax, current_y, sd.payload_radius,
                  sd.payload_length, sd.payload_mass)
    _annotate_dim(ax, sd.payload_radius + 0.3,
                  current_y, current_y + sd.payload_length)

    fairing_y = stage3_y + sd.stage3_engine_length + S3_GAP
    _draw_fairing(ax, fairing_y, sd.fairing_radius,
                  sd.payload_radius, sd.fairing_length)
    _annotate_dim(ax, sd.fairing_radius + 0.7,
                  fairing_y, fairing_y + sd.fairing_length,
                  color='gray', ha='right', x_text_offset=0.4)

    handles = [
        patches.Patch(color=COLORS['engine'],     label='Engine'),
        patches.Patch(color=COLORS['fuel'],       label='Fuel'),
        patches.Patch(color=COLORS['oxidizer'],   label='Oxidizer'),
        patches.Patch(color=COLORS['wall'],       label='Tank Walls'),
        patches.Patch(color=COLORS['tank_head'],  label='Tank Heads'),
        patches.Patch(color=COLORS['interstage'], label='Interstage'),
        patches.Patch(color=COLORS['payload'],    label='Payload'),
        patches.Patch(color=COLORS['fairing'], alpha=0.3, label='Fairing'),
    ]
    ax.legend(handles=handles, loc='center left', bbox_to_anchor=(1.02, 0.5))


# ──────────────────────────────────────────────────────────────────────
#  JSON persistence (for live GUI drawing)
# ──────────────────────────────────────────────────────────────────────

def _save_rocket_json(sd):
    """Persist the subset of attributes needed for live drawing."""
    data = {k: float(getattr(sd, k)) for k in _SKETCH_ATTRS}
    out = _output_dir() / "rocket_data.json"
    out.write_text(json.dumps(data, indent=2))


# ──────────────────────────────────────────────────────────────────────
#  Public entry point (file export)
# ──────────────────────────────────────────────────────────────────────

def generate_sketch(static_data):
    """Generate the rocket structure diagram from a StaticMomentOfInertia.

    Saves rocket_structure.png, .pdf, and rocket_data.json into the
    output directory — CC_OUTPUT_DIR when set (web, per-session), else
    ``src/sketch/`` (desktop).
    """
    sd = static_data
    out_dir = _output_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    total_height = (sd.payload_length + sd.stage3_length +
                    sd.stage23_interstage_length + sd.stage2_length +
                    sd.stage12_interstage_length + sd.stage1_length)
    stage3_start_est = (sd.stage1_length + sd.stage12_interstage_length +
                        sd.stage2_length + sd.stage23_interstage_length)
    fairing_top_est = (stage3_start_est + sd.stage3_engine_length +
                       S3_GAP + sd.fairing_length)
    max_height = max(total_height, fairing_top_est)

    fig_height = max(30, max_height * 0.7)
    fig, ax = plt.subplots(1, 1, figsize=(14, fig_height))

    draw_sketch(ax, sd)

    plt.subplots_adjust(left=0.08, right=0.82, top=0.94, bottom=0.04)
    out = out_dir / "rocket_structure.png"
    plt.savefig(out, dpi=300, bbox_inches='tight', pad_inches=0.8)
    plt.savefig(out_dir / "rocket_structure.pdf",
                bbox_inches='tight', pad_inches=0.8)
    print(f"\nRocket structure sketch saved to: {out}")
    plt.close(fig)

    _save_rocket_json(sd)
