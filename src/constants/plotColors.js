/**
 * Shared plot palette — mirror of core/gui/config.py::PLOT_COLORS,
 * retuned for the dark background. Single source for every Plotly
 * view (Trajectory plots, Compare overlays, TDMS analyzer) so channel
 * colors stay consistent across the suite.
 */
export const PLOT_COLORS = [
  '#4DA8DA', '#E06070', '#4ADE9A', '#E8AB2D', '#A78BFA',
  '#F0825C', '#34D399', '#C084FC', '#60A5FA', '#FBBF24',
  '#F87171', '#22D3EE', '#A855F7', '#84CC16', '#FB923C',
];

export const colorFor = (idx) => PLOT_COLORS[idx % PLOT_COLORS.length];
