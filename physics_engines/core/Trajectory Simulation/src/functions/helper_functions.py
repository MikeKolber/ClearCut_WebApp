import numpy as np
import os
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import plotly.io as pio


def interp1value(target_times, sim_times, sim_data):
    """
    Interpolate 1D simulation data onto specified target times using numpy.interp.

    Args:
        target_times (iterable of float): Times at which to sample the simulation (e.g., Excel times).
        sim_times (iterable of float): Sorted simulation time history.
        sim_data (iterable of float): Data values corresponding to sim_times.

    Returns:
        dict: Mapping each t in target_times to the interpolated sim_data value.
    """
    times = np.array(sim_times, dtype=float)
    data = np.array(sim_data, dtype=float)

    # Use numpy.interp for fast 1D linear interpolation
    # left and right parameters ensure out-of-bounds times use endpoint values
    interpolated = np.interp(
        target_times,
        times,
        data,
        left=data[0],
        right=data[-1]
    )

    # Build dictionary mapping each target time to its interpolated value
    return {float(t): float(val) for t, val in zip(target_times, interpolated)}


def interp3values(target_times, sim_times, sim_positions):

    times = np.array(sim_times, dtype=float)
    pos = np.array(sim_positions, dtype=float)  # shape (N,3)

    # Interpolate each coordinate separately, using endpoints for out-of-bounds
    x_interp = np.interp(target_times, times, pos[:, 0], left=pos[0, 0], right=pos[-1, 0])
    y_interp = np.interp(target_times, times, pos[:, 1], left=pos[0, 1], right=pos[-1, 1])
    z_interp = np.interp(target_times, times, pos[:, 2], left=pos[0, 2], right=pos[-1, 2])

    # Build dictionary mapping each target time to its interpolated 3D tuple
    return {
        float(t): (float(x), float(y), float(z))
        for t, x, y, z in zip(target_times, x_interp, y_interp, z_interp)
    }


def create_plot(sim_array, sim_interp_dict, excel_array, target_times, sim_times,
                sim_label, excel_label, y_label, title, filename):
    """
    Generate a professional side-by-side Plotly figure comparing simulation vs Excel data
    and the percentage difference, with thinner lines and minimally larger markers.
    Saves to `filename` and also to the user's Desktop.
    """
    # Prepare data
    times = [float(t) for t in target_times]
    sim_data = dict(zip(sim_times, sim_array))
    excel_data = dict(zip(times, excel_array))

    # Compute percent difference
    sim_vals = [sim_interp_dict[t] for t in times]
    ex_vals  = [excel_data[t] for t in times]
    pct_diff = [100*(ex - sim)/ex if ex != 0 else 0 for sim, ex in zip(sim_vals, ex_vals)]

    # Create subplots
    fig = make_subplots(
        rows=1, cols=2,
        subplot_titles=(title, "% Difference"),
        horizontal_spacing=0.15
    )

    # Define line width and marker size
    line_width = 1
    marker_size = 1.5  # 1.5x the line width

    # Left plot: simulation and Excel
    fig.add_trace(
        go.Scatter(
            x=list(sim_data.keys()),
            y=list(sim_data.values()),
            mode='lines+markers',
            name=sim_label,
            marker=dict(size=marker_size),
            line=dict(width=line_width)
        ), row=1, col=1
    )
    fig.add_trace(
        go.Scatter(
            x=times,
            y=[excel_data[t] for t in times],
            mode='lines+markers',
            name=excel_label,
            marker=dict(symbol='diamond', size=marker_size),
            line=dict(dash='dot', width=line_width)
        ), row=1, col=1
    )
    fig.update_xaxes(
        title_text="Time (s)",
        row=1, col=1,
        showgrid=True, gridcolor='lightgray',
        showspikes=True, spikecolor='gray', spikethickness=1,
        spikemode='across'
    )
    fig.update_yaxes(
        title_text=y_label,
        row=1, col=1,
        showgrid=True, gridcolor='lightgray',
        showspikes=True, spikecolor='gray', spikethickness=1,
        spikemode='across'
    )

    # Right plot: % difference
    fig.add_trace(
        go.Scatter(
            x=times,
            y=pct_diff,
            mode='lines+markers',
            name="% Difference",
            marker=dict(size=marker_size),
            line=dict(dash='dot', width=line_width)
        ), row=1, col=2
    )
    # zero reference line
    fig.add_shape(
        type="line",
        x0=min(times), x1=max(times),
        y0=0, y1=0,
        line=dict(color="black", width=line_width, dash="dash"),
        row=1, col=2
    )
    fig.update_xaxes(
        title_text="Time (s)",
        row=1, col=2,
        showgrid=True, gridcolor='lightgray',
        showspikes=True, spikecolor='gray', spikethickness=1,
        spikemode='across'
    )
    fig.update_yaxes(
        title_text="% Difference",
        row=1, col=2,
        showgrid=True, gridcolor='lightgray',
        showspikes=True, spikecolor='gray', spikethickness=1,
        spikemode='across'
    )

    # Layout styling
    fig.update_layout(
        template='plotly_white',
        title=dict(text=title, x=0.5, font_size=18),
        font=dict(family='Arial, sans-serif', size=12),
        legend=dict(
            orientation="h",
            yanchor="bottom", y=1.02,
            xanchor="right", x=1
        ),
        hovermode='x unified',
        plot_bgcolor='white',
        margin=dict(l=50, r=50, t=80, b=50)
    )

    # Save to provided filename and to Desktop
    pio.write_html(fig, file=filename, auto_open=True)
    desktop_path = os.path.join(os.path.expanduser("~"), "Desktop", filename)
    pio.write_html(fig, file=desktop_path, auto_open=False)
