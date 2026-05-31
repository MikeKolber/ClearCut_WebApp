import numpy as np
import math
from scipy.optimize import fsolve

# ================================================================
# HELPER FUNCTIONS FOR PROPELLANT CALCULATIONS
# ================================================================

def find_hemisphere_height(target_mass, radius, density):
    """Find fill height in hemisphere for given mass"""
    target_volume = target_mass / density
    full_volume = (2/3) * math.pi * radius**3
    
    if target_volume >= full_volume:
        return radius
        
    def equation(h):
        volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
        return volume - target_volume
    
    h_solution = fsolve(equation, [radius * 0.5])[0]
    return min(max(h_solution, 0), radius)

def find_annular_height(target_volume, bottom_prop_rad, top_prop_rad):
    """Find height where annular volume equals target volume"""
    if target_volume <= 0:
        return 0
        
    def equation(h):
        cyl_vol = math.pi * bottom_prop_rad**2 * h[0]
        hem_vol = math.pi * h[0]**2 * (3*top_prop_rad - h[0]) / 3 if h[0] < top_prop_rad else (2/3) * math.pi * top_prop_rad**3
        return cyl_vol - hem_vol - target_volume
    
    h_solution = fsolve(equation, [bottom_prop_rad * 0.5])[0]
    return min(max(h_solution, 0), bottom_prop_rad)

# ================================================================
# MAIN PROPELLANT CALCULATION FUNCTIONS FOR STAGES 1&2
# ================================================================

def calculate_current_fuel_and_ox_masses_and_lengths_stages12(total_propellant_mass, of_ratio, 
                                                    original_fuel_mass, original_fuel_volume,
                                                    original_ox_mass, original_ox_volume, 
                                                    stage_radius, tank_thickness,
                                                    fuel_length_initial, ox_length_initial,
                                                    tank_head_length, propellant_order):
    """
    Calculate current fuel and oxidizer masses, lengths, and COMs for stages 1&2
    
    Returns:
        tuple: (current_fuel_mass, current_ox_mass, fuel_length, ox_length, fuel_com, ox_com)
                - COMs are distances from the top of the stage
    """
    
    # Map propellants to physical positions in tanks
    propellant_mapping = _create_propellant_mapping(
        propellant_order, 
        original_fuel_mass, original_fuel_volume, fuel_length_initial,
        original_ox_mass, original_ox_volume, ox_length_initial
    )
    
    # Calculate current masses based on oxidizer-to-fuel ratio
    fuel_fraction = 1 / (1 + of_ratio)
    current_fuel_mass = total_propellant_mass * fuel_fraction
    current_ox_mass = total_propellant_mass * (of_ratio / (1 + of_ratio))

    # Map to bottom/top based on propellant order
    if propellant_order == "fuel_first":
        current_bottom_propellant_mass = current_fuel_mass
        current_top_propellant_mass = current_ox_mass
    else:
        current_bottom_propellant_mass = current_ox_mass
        current_top_propellant_mass = current_fuel_mass
    
    # Calculate tank geometry parameters
    propellant_radius = stage_radius - tank_thickness
    bottom_propellant_density = propellant_mapping['bottom']['original_mass'] / propellant_mapping['bottom']['original_volume']
    top_propellant_density = propellant_mapping['top']['original_mass'] / propellant_mapping['top']['original_volume']
    
    # Calculate propellant distributions
    bottom_props = _calculate_bottom_propellant_properties(
        current_bottom_propellant_mass,
        propellant_mapping['bottom']['original_mass'],
        bottom_propellant_density,
        propellant_radius,
        stage_radius
    )
    
    top_props = _calculate_top_propellant_properties(
        current_top_propellant_mass,
        propellant_mapping['top']['original_mass'],
        top_propellant_density,
        propellant_radius
    )
    
    # Convert to absolute positions from stage top
    positions = _calculate_absolute_positions(
        propellant_order,
        tank_head_length,
        propellant_mapping,
        bottom_props,
        top_props
    )
    
    # Return values in fuel/ox order regardless of physical position
    if propellant_order == "fuel_first":
        return (current_fuel_mass, current_ox_mass, 
                bottom_props['length'], top_props['length'],
                positions['bottom_com'], positions['top_com'])
    else:
        return (current_fuel_mass, current_ox_mass,
                top_props['length'], bottom_props['length'],
                positions['top_com'], positions['bottom_com'])

# ================================================================
# HELPER FUNCTIONS FOR STAGES 1&2 CALCULATIONS
# ================================================================

def _create_propellant_mapping(propellant_order, fuel_mass, fuel_volume, fuel_length,
                              ox_mass, ox_volume, ox_length):
    """Map propellant types to their physical positions in the stage"""
    if propellant_order == "fuel_first":
        return {
            'bottom': {
                'type': 'fuel',
                'original_mass': fuel_mass,
                'original_volume': fuel_volume,
                'length_initial': fuel_length
            },
            'top': {
                'type': 'ox',
                'original_mass': ox_mass,
                'original_volume': ox_volume,
                'length_initial': ox_length
            }
        }
    else:
        return {
            'bottom': {
                'type': 'ox',
                'original_mass': ox_mass,
                'original_volume': ox_volume,
                'length_initial': ox_length
            },
            'top': {
                'type': 'fuel',
                'original_mass': fuel_mass,
                'original_volume': fuel_volume,
                'length_initial': fuel_length
            }
        }

def _calculate_bottom_propellant_properties(current_mass, original_mass, density, 
                                          propellant_radius, stage_radius):
    """
    Calculate distribution of bottom propellant across three regions:
    1. Bottom hemisphere
    2. Middle cylinder
    3. Annular region around inverted top propellant bulkhead
    """
    # Calculate fixed geometry parameters
    hemisphere_volume = (2/3) * math.pi * propellant_radius**3
    hemisphere_mass = hemisphere_volume * density
    
    # Annular region parameters
    annular_cylinder_vol = math.pi * propellant_radius**3
    inverted_hemisphere_vol = (2/3) * math.pi * stage_radius**3
    annular_vol_max = annular_cylinder_vol - inverted_hemisphere_vol
    annular_mass_max = annular_vol_max * density
    
    # Middle cylinder parameters
    cylinder_mass_max = original_mass - annular_mass_max - hemisphere_mass
    cylinder_length_max = cylinder_mass_max / (density * math.pi * propellant_radius**2)
    
    # Determine which regions contain propellant
    if current_mass >= hemisphere_mass + cylinder_mass_max:
        return _calculate_bottom_propellant_annular_case(
            current_mass, hemisphere_mass, cylinder_mass_max, cylinder_length_max,
            density, propellant_radius, stage_radius
        )
    elif current_mass >= hemisphere_mass:
        return _calculate_bottom_propellant_cylinder_case(
            current_mass, hemisphere_mass, density, propellant_radius
        )
    else:
        return _calculate_bottom_propellant_hemisphere_case(
            current_mass, density, propellant_radius
        )

def _calculate_bottom_propellant_annular_case(current_mass, hemisphere_mass, cylinder_mass_max,
                                                cylinder_length_max, density, propellant_radius, stage_radius):
    """Calculate properties when bottom propellant fills all three regions"""
    annular_mass = current_mass - hemisphere_mass - cylinder_mass_max
    annular_volume = annular_mass / density
    annular_height = find_annular_height(annular_volume, propellant_radius, stage_radius)
    
    # Calculate annular region center of mass
    cylinder_vol = math.pi * propellant_radius**2 * annular_height
    cylinder_com = annular_height / 2
    
    if annular_height < stage_radius:
        hem_vol = math.pi * annular_height**2 * (3*stage_radius - annular_height) / 3
        hem_com = annular_height * (3*stage_radius - annular_height) / (4*(2*stage_radius - annular_height))
    else:
        hem_vol = (2/3) * math.pi * stage_radius**3
        hem_com = 3*stage_radius/8
        
    annular_com_from_base = (cylinder_com * cylinder_vol - hem_com * hem_vol) / (cylinder_vol - hem_vol)
        
    # Calculate component COMs from tank bottom
    hemisphere_com = (3 * propellant_radius) / 8
    cylinder_com = propellant_radius + cylinder_length_max / 2
    annular_com = propellant_radius + cylinder_length_max + annular_com_from_base
    
    # Calculate combined center of mass
    total_com = (hemisphere_com * hemisphere_mass + 
                cylinder_com * cylinder_mass_max + 
                annular_com * annular_mass) / current_mass
    
    total_length = propellant_radius + cylinder_length_max + annular_height
    
    return {
        'com': total_com,
        'length': total_length,
        'fullness': 'annular'
    }

def _calculate_bottom_propellant_cylinder_case(current_mass, hemisphere_mass, density, propellant_radius):
    """Calculate properties when bottom propellant fills hemisphere and partial cylinder"""
    cylinder_mass = current_mass - hemisphere_mass
    cylinder_length = cylinder_mass / (density * math.pi * propellant_radius**2)
    
    hemisphere_com = (3 * propellant_radius) / 8
    cylinder_com = propellant_radius + cylinder_length / 2
    
    total_com = (hemisphere_com * hemisphere_mass + 
                cylinder_com * cylinder_mass) / current_mass
    
    total_length = propellant_radius + cylinder_length
    
    return {
        'com': total_com,
        'length': total_length,
        'fullness': 'cylinder'
    }

def _calculate_bottom_propellant_hemisphere_case(current_mass, density, propellant_radius):
    """Calculate properties when bottom propellant only partially fills hemisphere"""
    height = find_hemisphere_height(current_mass, propellant_radius, density)
    
    if height > 0:
        t = height / propellant_radius
        com = propellant_radius * t * (4 - t) / (4 * (3 - t))
    else:
        com = 0
    
    return {
        'com': com,
        'length': height,
        'fullness': 'hemisphere'
    }

def _calculate_top_propellant_properties(current_mass, original_mass, density, propellant_radius):
    """
    Calculate distribution of top propellant across three regions:
    1. Bottom hemisphere (pointing down)
    2. Middle cylinder
    3. Top hemisphere (pointing up)
    """
    # Calculate fixed geometry parameters
    hemisphere_volume = (2/3) * math.pi * propellant_radius**3
    hemisphere_mass = hemisphere_volume * density
    
    # Top propellant has two hemispheres
    cylinder_mass_max = original_mass - 2 * hemisphere_mass
    cylinder_length_max = cylinder_mass_max / (density * math.pi * propellant_radius**2)
    
    # Determine which regions contain propellant
    if current_mass >= hemisphere_mass + cylinder_mass_max:
        return _calculate_top_propellant_top_hemisphere_case(
            current_mass, hemisphere_mass, cylinder_mass_max, cylinder_length_max,
            density, propellant_radius
        )
    elif current_mass >= hemisphere_mass:
        return _calculate_top_propellant_cylinder_case(
            current_mass, hemisphere_mass, density, propellant_radius
        )
    else:
        return _calculate_top_propellant_hemisphere_case(
            current_mass, density, propellant_radius
        )

def _calculate_top_propellant_top_hemisphere_case(current_mass, hemisphere_mass, cylinder_mass_max,
                                                  cylinder_length_max, density, propellant_radius):
    """Calculate properties when top propellant fills all three regions"""
    top_hemisphere_mass = current_mass - hemisphere_mass - cylinder_mass_max
    top_hemisphere_height = find_hemisphere_height(top_hemisphere_mass, propellant_radius, density)
    
    # Calculate component COMs
    bottom_hemisphere_com = (3 * propellant_radius) / 8
    cylinder_com = propellant_radius + cylinder_length_max / 2
    
    # Top hemisphere COM calculation
    if top_hemisphere_height > 0:
        h = top_hemisphere_height
        R = propellant_radius
        if h >= R:
            top_hem_com_from_base = (5 * R) / 8
        else:
            top_hem_com_from_base = h - (h * (4*R - h)) / (4 * (3*R - h))
    else:
        top_hem_com_from_base = 0
    
    top_hemisphere_com = propellant_radius + cylinder_length_max + top_hem_com_from_base
    
    # Calculate combined center of mass
    total_com = (bottom_hemisphere_com * hemisphere_mass + 
                cylinder_com * cylinder_mass_max + 
                top_hemisphere_com * top_hemisphere_mass) / current_mass
    
    total_length = propellant_radius + cylinder_length_max + top_hemisphere_height
    
    return {
        'com': total_com,
        'length': total_length,
        'fullness': 'top_hemisphere'
    }

def _calculate_top_propellant_cylinder_case(current_mass, hemisphere_mass, density, propellant_radius):
    """Calculate properties when top propellant fills bottom hemisphere and partial cylinder"""
    cylinder_mass = current_mass - hemisphere_mass
    cylinder_length = cylinder_mass / (density * math.pi * propellant_radius**2)
    
    bottom_hemisphere_com = (3 * propellant_radius) / 8
    cylinder_com = propellant_radius + cylinder_length / 2
    
    total_com = (bottom_hemisphere_com * hemisphere_mass + 
                cylinder_com * cylinder_mass) / current_mass
    
    total_length = propellant_radius + cylinder_length
    
    return {
        'com': total_com,
        'length': total_length,
        'fullness': 'cylinder'
    }

def _calculate_top_propellant_hemisphere_case(current_mass, density, propellant_radius):
    """Calculate properties when top propellant only partially fills bottom hemisphere"""
    height = find_hemisphere_height(current_mass, propellant_radius, density)
    
    if height > 0:
        t = height / propellant_radius
        com = propellant_radius * t * (4 - t) / (4 * (3 - t))
    else:
        com = 0
    
    return {
        'com': com,
        'length': height,
        'fullness': 'hemisphere'
    }

def _calculate_absolute_positions(propellant_order, tank_head_length, propellant_mapping,
                                 bottom_props, top_props):
    """Convert tank-relative positions to stage-relative positions"""
    if propellant_order == "fuel_first":
        # Configuration: [ox tank] -> [fuel tank] -> [engine]
        top_tank_bottom = propellant_mapping['top']['length_initial']  # top tank starts after fuel length
        bottom_tank_bottom = propellant_mapping['top']['length_initial'] - tank_head_length + propellant_mapping['bottom']['length_initial']  # bottom tank starts after fuel + ox
        
        top_com = top_tank_bottom + top_props['com']
        bottom_com = bottom_tank_bottom + bottom_props['com']
    else: # TODO: fix this
        # Configuration: [fuel tank] -> [ox tank] -> [engine]
        bottom_tank_bottom = tank_head_length
        top_tank_bottom = tank_head_length + propellant_mapping['bottom']['length_initial']
        
        bottom_com = bottom_tank_bottom + bottom_props['com']
        top_com = top_tank_bottom + top_props['com']
    
    return {
        'bottom_com': bottom_com,
        'top_com': top_com
    }

# ================================================================
# MAIN PROPELLANT CALCULATION FUNCTION FOR STAGE 3
# ================================================================

def calculate_current_fuel_and_ox_masses_and_lengths_stage3(total_propellant_mass, of_ratio, 
                                                    original_fuel_mass, original_fuel_volume,
                                                    original_ox_mass, original_ox_volume, 
                                                    stage_radius, tank_thickness,
                                                    fuel_length_initial, ox_length_initial,
                                                    tank_head_length, propellant_order):
    """
    Calculate current fuel and oxidizer masses, lengths, and COMs for stage 3 spherical tanks
    
    Returns:
        tuple: (current_fuel_mass, current_ox_mass, fuel_length, ox_length, fuel_com, ox_com)
                - COMs are distances from the top of the stage
    """
    
    # Calculate current masses based on oxidizer-to-fuel ratio
    fuel_fraction = 1 / (1 + of_ratio)
    current_fuel_mass = total_propellant_mass * fuel_fraction
    current_ox_mass = total_propellant_mass * (of_ratio / (1 + of_ratio))
    
    # Calculate propellant properties
    fuel_density = original_fuel_mass / original_fuel_volume
    ox_density = original_ox_mass / original_ox_volume
    fuel_radius = ox_radius = stage_radius - tank_thickness
    
    # Calculate fill heights in spherical tanks
    fuel_length = _find_sphere_height(current_fuel_mass, fuel_radius, fuel_density)
    ox_length = _find_sphere_height(current_ox_mass, ox_radius, ox_density)
    
    # Calculate centers of mass within each sphere
    fuel_com_in_sphere = _calculate_sphere_com(fuel_length, fuel_radius, fuel_density)
    ox_com_in_sphere = _calculate_sphere_com(ox_length, ox_radius, ox_density)
    
    # Calculate absolute positions based on tank arrangement
    if propellant_order == "fuel_first":
        fuel_com_from_top = tank_head_length + fuel_com_in_sphere
        ox_com_from_top = tank_head_length + 2 * fuel_radius + ox_com_in_sphere
    else:
        ox_com_from_top = tank_head_length + ox_com_in_sphere
        fuel_com_from_top = tank_head_length + 2 * ox_radius + fuel_com_in_sphere
    
    return current_fuel_mass, current_ox_mass, fuel_length, ox_length, fuel_com_from_top, ox_com_from_top

# ================================================================
# HELPER FUNCTIONS FOR STAGE 3 CALCULATIONS
# ================================================================

def _find_sphere_height(target_mass, radius, density):
    """Find fill height in sphere for given mass"""
    target_volume = target_mass / density
    full_volume = (4/3) * math.pi * radius**3
    
    if target_volume >= full_volume:
        return 2 * radius
        
    def equation(h):
        volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
        return volume - target_volume
        
    h_solution = fsolve(equation, [radius])[0]
    return h_solution

def _calculate_sphere_com(height, radius, density):
    """Calculate COM of liquid in sphere, measured from bottom"""
    if height >= 2 * radius:
        return radius
    elif height > radius:
        # Sphere is more than half full
        bottom_mass = (2/3) * math.pi * radius**3 * density
        top_height = height - radius
        top_volume = math.pi * top_height**2 * (3*radius - top_height) / 3
        top_mass = top_volume * density
        total_mass = bottom_mass + top_mass
        
        bottom_com = _hemisphere_com(radius, radius, "down")
        top_com_from_base = _hemisphere_com(top_height, radius, "up")
        top_com = radius + top_com_from_base
        
        return (bottom_mass * bottom_com + top_mass * top_com) / total_mass
    else:
        # Sphere is less than half full
        return _hemisphere_com(height, radius, "down")

def _hemisphere_com(height, radius, pointing):
    """Calculate COM for hemisphere (pointing up or down)"""
    if pointing == "down":
        if height >= radius:
            return (3 * radius) / 8
        else:
            return height * (4*radius - height) / (4 * (3*radius - height))
    else:
        if height >= radius:
            return (5 * radius) / 8
        else:
            return height - (height * (4*radius - height)) / (4 * (3*radius - height))
    
# ================================================================
# STRUCTURAL COMPONENT CALCULATIONS
# ================================================================

def calculate_component_com(engine_length, fuel_length_initial, fuel_length_current, ox_length_initial, ox_length_current, tank_head_length, propellant_order, stage_num, tank_thickness, fuel_com, ox_com, stage_radius):
    """
    Calculate structural component COMs relative to stage top.
    Note: fuel_com and ox_com are passed from propellant calculations.
    """

    if propellant_order == "fuel_first":
        if stage_num == 3:
            # Spherical tanks
            fuel_sphere_radius = stage_radius - tank_thickness
            ox_sphere_radius = stage_radius - tank_thickness
            
            bottom_tank_com = tank_head_length + fuel_sphere_radius
            top_tank_com = tank_head_length + 2 * fuel_sphere_radius + ox_sphere_radius
        else:
            # Cylindrical tanks
            top_tank_com = tank_thickness + ox_length_initial / 2
            bottom_tank_com = tank_thickness + ox_length_initial + fuel_length_initial / 2
        
        engine_com = ox_length_initial + fuel_length_initial + tank_thickness * 2 + engine_length / 2
        print("ox length initial", ox_length_initial)
        print("fuel length initial", fuel_length_initial)
        print("tank thickness", tank_thickness)
        print("engine length", engine_length)
        print("engine_com", engine_com)
        print("bottom_tank_com", bottom_tank_com)
        print("top_tank_com", top_tank_com)

    elif propellant_order == "ox_first": # TODO: fix this
        if stage_num == 3:
            # Spherical tanks
            fuel_sphere_radius = stage_radius - tank_thickness
            ox_sphere_radius = stage_radius - tank_thickness
            
            bottom_tank_com = tank_head_length + ox_sphere_radius
            top_tank_com = tank_head_length + 2 * ox_sphere_radius + fuel_sphere_radius
        else:
            # Cylindrical tanks
            top_tank_com = tank_head_length + fuel_length_initial / 2
            bottom_tank_com = tank_head_length + fuel_length_initial + ox_length_initial / 2
            
        engine_com = tank_head_length + fuel_length_initial + ox_length_initial + tank_head_length + engine_length / 2
    
    return engine_com, fuel_com, ox_com, bottom_tank_com, top_tank_com

def calculate_hemispherical_shell_com(base_position, radius, orientation):
    """Calculate center of mass for hemispherical shell (tank head)"""
    com_offset = (3 * radius) / 8
    
    if orientation == 'up':
        com_x = base_position + com_offset
    elif orientation == 'down':
        com_x = base_position - com_offset
    else:
        raise ValueError("Orientation must be 'up' or 'down'")
    
    return com_x

# ================================================================
# MOMENT OF INERTIA CALCULATIONS FOR SIMPLE SHAPES
# ================================================================

def calculate_solid_cylinder_component_moment_of_inertia(mass, length, radius):
    """Calculate moment of inertia for solid cylinder"""
    I_xx = (mass * (radius**2)) / 2
    I_yy = (mass * (length**2))/12 + (mass * (radius**2))/4
    I_zz = (mass * (length**2))/12 + (mass * (radius**2))/4
    I_xy = I_xz = I_yx = I_yz = I_zx = I_zy = 0
    
    inertia_matrix = np.array([
        [I_xx, I_xy, I_xz],
        [I_yx, I_yy, I_yz],
        [I_zx, I_zy, I_zz]
    ])
    
    return inertia_matrix

def calculate_hollow_cylinder_component_moment_of_inertia(mass, length, radius):
    """Calculate moment of inertia for hollow cylinder"""
    I_xx = mass * (radius**2)
    I_yy = (mass * (length**2))/12 + (mass * (radius**2))/2
    I_zz = (mass * (length**2))/12 + (mass * (radius**2))/2
    I_xy = I_xz = I_yx = I_yz = I_zx = I_zy = 0
    
    inertia_matrix = np.array([
        [I_xx, I_xy, I_xz],
        [I_yx, I_yy, I_yz],
        [I_zx, I_zy, I_zz]
    ])
    
    return inertia_matrix
    
def calculate_hollow_cylinder_with_radii_moment_of_inertia(mass, length, inner_radius, outer_radius):
    """Calculate moment of inertia for hollow cylinder with specified inner and outer radii"""
    I_xx = mass * (outer_radius**2 + inner_radius**2) / 2
    I_yy = (mass * length**2)/12 + mass * (outer_radius**2 + inner_radius**2) / 4
    I_zz = (mass * length**2)/12 + mass * (outer_radius**2 + inner_radius**2) / 4
    I_xy = I_xz = I_yx = I_yz = I_zx = I_zy = 0
    
    inertia_matrix = np.array([
        [I_xx, I_xy, I_xz],
        [I_yx, I_yy, I_yz],
        [I_zx, I_zy, I_zz]
    ])
    
    return inertia_matrix

def calculate_hemispherical_shell_moment_of_inertia(mass, radius):
    """Calculate moment of inertia for hemispherical shell (tank head)"""
    I_xx = (2 * mass * (radius**2)) / 3
    I_yy = (5 * mass * (radius**2)) / 12
    I_zz = (5 * mass * (radius**2)) / 12
    I_xy = I_xz = I_yx = I_yz = I_zx = I_zy = 0
    
    inertia_matrix = np.array([
        [I_xx, I_xy, I_xz],
        [I_yx, I_yy, I_yz],
        [I_zx, I_zy, I_zz]
    ])
    
    return inertia_matrix

def calculate_hemisphere_moment_of_inertia(mass, radius, fill_height):
    """
    Calculate moment of inertia for hemisphere (partial or full) about its base center.
    This unified function ensures continuity between partial and full cases.
    
    Parameters:
    - mass: Current mass in the hemisphere
    - radius: Hemisphere radius
    - fill_height: Current fill height from bottom (0 to radius)
    
    Returns:
    - 3x3 inertia tensor about the base (flat surface)
    """
    if fill_height <= 0:
        return np.zeros((3, 3))
    
    R = radius
    h = min(fill_height, R)
    
    # Normalized fill fraction
    fill_fraction = h / R
    
    # COM position from base
    t = min(fill_fraction, 1.0)
    com_from_base = R * t * (4 - t) / (4 * (3 - t))
    
    # MOI about COM with smooth interpolation
    ff = min(fill_fraction, 1.0)
    I_com_xx = mass * R**2 * (0.083 * ff**2)
    I_com_yy = mass * R**2 * (0.0645 * ff**2)
    I_com_zz = mass * R**2 * (0.0645 * ff**2)
    
    # Apply parallel axis theorem to shift to base
    I_base_xx = I_com_xx
    I_base_yy = I_com_yy + mass * com_from_base**2
    I_base_zz = I_com_zz + mass * com_from_base**2
    
    inertia_matrix = np.array([
        [I_base_xx, 0, 0],
        [0, I_base_yy, 0],
        [0, 0, I_base_zz]
    ])
    
    return inertia_matrix

def calculate_fuel_cylinder_length(total_fuel_mass, radius, tank_thickness, fuel_density):
    """
    Calculate the actual cylinder length for fuel stored as hemisphere + cylinder + hemisphere
    """
    fuel_radius = radius - tank_thickness
    hemisphere_volume = (2/3) * math.pi * fuel_radius**3
    hemisphere_mass = hemisphere_volume * fuel_density
    
    # Calculate mass in annular region
    cylinder_around_ox_mass = math.pi * fuel_radius**3 * fuel_density
    ox_full_hemesphere_mass = (2/3) * math.pi * radius**3 * fuel_density
    fuel_mass_around_ox = cylinder_around_ox_mass - ox_full_hemesphere_mass

    remaining_mass = total_fuel_mass - (hemisphere_mass + fuel_mass_around_ox)
    cylinder_volume = remaining_mass / fuel_density
    cyl_length = cylinder_volume / (math.pi * fuel_radius**2)
    
    return cyl_length

def calculate_solid_sphere_moment_of_inertia(mass, radius):
    """Calculate moment of inertia for solid sphere about its center"""
    I_sphere = (2 * mass * radius**2) / 5
    
    inertia_matrix = np.array([
        [I_sphere, 0, 0],
        [0, I_sphere, 0],
        [0, 0, I_sphere]
    ])
    
    return inertia_matrix

# ================================================================
# STAGE 3 PROPELLANT MOMENT OF INERTIA CALCULATIONS
# ================================================================

def calculate_stage3_propellant_moment_of_inertia(
        propellant_mass,
        propellant_volume,
        tank_radius,
        tank_thickness,
        propellant_density,
        is_bottom_propellant,
        total_tank_volume=None,
        fill_fraction=None
    ):
    """
    Calculate Stage 3 propellant MOI for spherical tanks
    
    Parameters:
    - propellant_mass: Current mass of propellant (kg)
    - propellant_volume: Current volume of propellant (m³)
    - tank_radius: Outer radius of the tank (m)
    - tank_thickness: Tank wall thickness (m)
    - propellant_density: Density of the propellant (kg/m³)
    - is_bottom_propellant: True if this is bottom propellant, False for top
    - total_tank_volume: Total volume available in tank (optional, m³)
    - fill_fraction: Alternative way to specify fill level (optional, 0-1)
    
    Returns:
    - 3x3 inertia tensor about the propellant's center of mass
    """
    # Calculate tank geometry
    inner_radius = tank_radius - tank_thickness
    tank_volume = 4/3 * math.pi * inner_radius**3
    tank_mass = tank_volume * propellant_density
    bottom_tank_volume = 2/3 * math.pi * inner_radius**3
    bottom_tank_mass = bottom_tank_volume * propellant_density

    # Determine fill state and calculate MOI
    if propellant_mass >= tank_mass:
        return calculate_solid_sphere_moment_of_inertia(propellant_mass, inner_radius)
    elif propellant_mass > bottom_tank_mass:
        return _calculate_stage3_moi_two_hemispheres(
            propellant_mass, inner_radius, propellant_density,
            bottom_tank_mass, is_bottom_propellant
        )
    else:
        return _calculate_stage3_moi_single_hemisphere(
            propellant_mass, inner_radius, propellant_density,
            is_bottom_propellant
        )

# ================================================================
# HELPER FUNCTIONS FOR STAGE 3 PROPELLANT MOI
# ================================================================

def _calculate_stage3_moi_two_hemispheres(propellant_mass, inner_radius, propellant_density, 
                                         bottom_tank_mass, is_bottom_propellant):
    """Calculate MOI when bottom hemisphere is full and top hemisphere is partially full"""
    bottom_hemisphere_mass = bottom_tank_mass
    top_hemisphere_mass = propellant_mass - bottom_hemisphere_mass
    
    # Find height of propellant in top hemisphere
    top_hemisphere_height = _find_stage3_hemisphere_height(top_hemisphere_mass, inner_radius, propellant_density)
    
    # Calculate COMs
    bottom_hemisphere_com = _hemisphere_com(inner_radius, inner_radius, "down")
    top_hemisphere_com_from_base = _hemisphere_com(top_hemisphere_height, inner_radius, "up")
    top_hemisphere_com = inner_radius + top_hemisphere_com_from_base
    
    # Calculate total COM
    total_com = (bottom_hemisphere_mass * bottom_hemisphere_com + 
                top_hemisphere_mass * top_hemisphere_com) / propellant_mass
    
    # Calculate inertias
    bottom_inertia = calculate_hemisphere_moment_of_inertia(bottom_hemisphere_mass, inner_radius, inner_radius)
    top_inertia = calculate_hemisphere_moment_of_inertia(top_hemisphere_mass, inner_radius, top_hemisphere_height)
    
    # Apply parallel axis theorem
    bottom_shifted = calculate_shifted_moment_of_inertia(bottom_inertia, bottom_hemisphere_mass, 
                                                       abs(total_com - bottom_hemisphere_com))
    top_shifted = calculate_shifted_moment_of_inertia(top_inertia, top_hemisphere_mass, 
                                                     abs(total_com - top_hemisphere_com))
    
    return np.array(bottom_shifted) + np.array(top_shifted)
            
def _calculate_stage3_moi_single_hemisphere(propellant_mass, inner_radius, propellant_density, 
                                          is_bottom_propellant):
    """Calculate MOI when only bottom hemisphere has propellant"""
    hemisphere_height = _find_stage3_hemisphere_height(propellant_mass, inner_radius, propellant_density)
    return calculate_hemisphere_moment_of_inertia(propellant_mass, inner_radius, hemisphere_height)

def _find_stage3_hemisphere_height(target_mass, radius, density):
    """Find fill height in hemisphere for given mass"""
    target_volume = target_mass / density
    full_volume = (2/3) * math.pi * radius**3
    
    if target_volume >= full_volume:
        return radius
    
    def equation(h):
        volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
        return volume - target_volume
    
    h_solution = fsolve(equation, [radius * 0.5])[0]
    return min(max(h_solution, 0), radius)

# ================================================================
# STATIC PROPELLANT MOI CALCULATIONS
# ================================================================

def calculate_stage_bottom_propellant_moment_of_inertia(total_bottom_propellant_mass, radius, tank_thickness, bottom_propellant_density, stage_num):
    """
    Calculate bottom propellant MOI for static (full tank) case
    """
    if stage_num == 3:
        # Stage 3: Use spherical tank function
        bottom_propellant_volume = total_bottom_propellant_mass / bottom_propellant_density
        
        return calculate_stage3_propellant_moment_of_inertia(
            propellant_mass=total_bottom_propellant_mass,
            propellant_volume=bottom_propellant_volume,
            tank_radius=radius,
            tank_thickness=tank_thickness,
            propellant_density=bottom_propellant_density,
            is_bottom_propellant=True
        )
    else:
        # Stages 1&2: Calculate full tank geometry then use dynamic function
        bottom_propellant_radius = radius - tank_thickness
        hemisphere_volume = (2/3) * math.pi * bottom_propellant_radius**3
        hemisphere_mass = hemisphere_volume * bottom_propellant_density
        
        # Calculate annular region parameters
        bottom_propellant_around_cylinder_mass = math.pi * bottom_propellant_radius**3 * bottom_propellant_density
        top_propellant_hemisphere_volume = (2/3) * math.pi * radius**3
        bottom_propellant_around_mass = bottom_propellant_around_cylinder_mass - top_propellant_hemisphere_volume * bottom_propellant_density
        
        # Calculate cylinder length
        cylinder_mass = total_bottom_propellant_mass - hemisphere_mass - bottom_propellant_around_mass
        if cylinder_mass > 0:
            cylinder_volume = cylinder_mass / bottom_propellant_density
            cylinder_length = cylinder_volume / (math.pi * bottom_propellant_radius**2)
            total_bottom_propellant_length = cylinder_length + radius * 2
        else:
            total_bottom_propellant_length = radius * 2
            
        return calculate_dynamic_bottom_propellant_moment_of_inertia_s12(
            total_bottom_propellant_mass,
            total_bottom_propellant_length,
            radius,
            tank_thickness,
            bottom_propellant_density,
            total_bottom_propellant_length
        )

# ================================================================
# DYNAMIC PROPELLANT MOI CALCULATIONS FOR STAGES 1&2
# ================================================================

def calculate_dynamic_bottom_propellant_moment_of_inertia_s12(current_bottom_propellant_mass, bottom_propellant_length, radius, tank_thickness, bottom_propellant_density, bottom_propellant_length_initial):
    """
    Calculate bottom propellant moment of inertia during flight.
    Accounts for propellant consumption from top to bottom.
    
    Returns:
    - 3x3 inertia tensor
    """
    bottom_propellant_radius = radius - tank_thickness
    hemisphere_volume = (2/3) * math.pi * bottom_propellant_radius**3
    hemisphere_mass = hemisphere_volume * bottom_propellant_density
    
    # Determine fill state
    if bottom_propellant_length > bottom_propellant_radius:
        if bottom_propellant_length < bottom_propellant_length_initial - bottom_propellant_radius:
            return _calculate_bottom_moi_cylinder_case(
                current_bottom_propellant_mass, hemisphere_mass,
                bottom_propellant_radius, bottom_propellant_density
            )
        else:
            return _calculate_bottom_moi_annular_case(
                current_bottom_propellant_mass, hemisphere_mass,
                bottom_propellant_radius, bottom_propellant_density,
                bottom_propellant_length_initial, radius
            )
    else:
        return _calculate_bottom_moi_hemisphere_case(
            current_bottom_propellant_mass, bottom_propellant_radius,
            bottom_propellant_density
        )

# ================================================================
# HELPER FUNCTIONS FOR DYNAMIC BOTTOM PROPELLANT MOI
# ================================================================

def _calculate_bottom_moi_cylinder_case(current_mass, hemisphere_mass, radius, density):
    """Calculate MOI when bottom hemisphere is full and cylinder is partially full"""
    cylinder_mass = current_mass - hemisphere_mass
    
    # Current cylinder length
    cyl_volume = cylinder_mass / density
    cyl_length = cyl_volume / (math.pi * radius**2)
    
    # Calculate inertias
    bottom_inertia = calculate_hemisphere_moment_of_inertia(hemisphere_mass, radius, radius)
    cylinder_inertia = calculate_solid_cylinder_component_moment_of_inertia(cylinder_mass, cyl_length, radius)
    
    # Calculate COMs relative to bottom of propellant
    bottom_com = (3 * radius) / 8
    cylinder_com = radius + cyl_length / 2
    total_com = (hemisphere_mass * bottom_com + cylinder_mass * cylinder_com) / current_mass
    
    # Apply parallel axis theorem
    bottom_shifted = calculate_shifted_moment_of_inertia(bottom_inertia, hemisphere_mass, total_com - bottom_com)
    cylinder_shifted = calculate_shifted_moment_of_inertia(cylinder_inertia, cylinder_mass, abs(total_com - cylinder_com))
    
    return np.array(bottom_shifted) + np.array(cylinder_shifted)

def _calculate_bottom_moi_annular_case(current_mass, hemisphere_mass, radius, density, 
                                      length_initial, stage_radius):
    """Calculate MOI when propellant extends into annular region"""
    # Calculate component masses
    cylinder_length = length_initial - 2 * radius
    cylinder_mass = cylinder_length * math.pi * radius**2 * density
    annular_mass = current_mass - hemisphere_mass - cylinder_mass
    annular_volume = annular_mass / density
    
    # Find height of propellant in annular region
    annular_height = _find_annular_height_for_moi(annular_volume, radius, stage_radius)
    
    # Calculate annular region MOI
    annular_moi = _calculate_annular_region_moi(
        annular_height, radius, stage_radius, density
    )
    
    # Calculate inertias for other components
    bottom_inertia = calculate_hemisphere_moment_of_inertia(hemisphere_mass, radius, radius)
    cylinder_inertia = calculate_solid_cylinder_component_moment_of_inertia(cylinder_mass, cylinder_length, radius)
    
    # Calculate COMs
    bottom_com = (3 * radius) / 8
    cylinder_com = radius + cylinder_length / 2
    annular_com = radius + cylinder_length + _calculate_annular_com(radius, stage_radius)
    
    # Total COM
    total_com = (hemisphere_mass * bottom_com + 
                cylinder_mass * cylinder_com + 
                annular_mass * annular_com) / current_mass
    
    # Apply parallel axis theorem
    bottom_shifted = calculate_shifted_moment_of_inertia(bottom_inertia, hemisphere_mass, abs(total_com - bottom_com))
    cylinder_shifted = calculate_shifted_moment_of_inertia(cylinder_inertia, cylinder_mass, abs(total_com - cylinder_com))
    annular_shifted = calculate_shifted_moment_of_inertia(annular_moi, annular_mass, abs(total_com - annular_com))
    
    return np.array(bottom_shifted) + np.array(cylinder_shifted) + np.array(annular_shifted)

def _calculate_bottom_moi_hemisphere_case(current_mass, radius, density):
    """Calculate MOI when only bottom hemisphere has propellant"""
    fill_height = _find_hemisphere_fill_height_for_moi(current_mass, radius, density)
    return calculate_hemisphere_moment_of_inertia(current_mass, radius, fill_height)

def _find_annular_height_for_moi(target_volume, cyl_radius, hem_radius):
    """Find height where annular volume equals target volume"""
    def equation(h):
        cylinder_vol = math.pi * cyl_radius**2 * h[0]
        hemisphere_vol = math.pi * h[0]**2 * (3*hem_radius - h[0]) / 3
        return cylinder_vol - hemisphere_vol - target_volume
    
    h_solution = fsolve(equation, [cyl_radius * 0.5], xtol=1e-9, maxfev=1000)
    return min(h_solution[0], hem_radius)

def _calculate_annular_region_moi(height, inner_radius, outer_radius, density):
    """Calculate MOI for annular region (cylinder minus inverted hemisphere)"""
    # Cylinder component
    cylinder_mass = math.pi * inner_radius**2 * height * density
    cylinder_moi = calculate_solid_cylinder_component_moment_of_inertia(
        cylinder_mass, height, inner_radius
    )
    
    # Hemisphere component to subtract
    hemisphere_volume = math.pi * height**2 * (3*outer_radius - height) / 3
    hemisphere_mass = hemisphere_volume * density
    hemisphere_moi = calculate_hemisphere_moment_of_inertia(
        hemisphere_mass, outer_radius, min(height, outer_radius)
    )
    
    return np.array(cylinder_moi) - np.array(hemisphere_moi)

def _calculate_annular_com(inner_radius, outer_radius):
    """Calculate COM of full annular region"""
    cyl_vol = math.pi * inner_radius**3
    hem_vol = (2/3) * math.pi * outer_radius**3
    annular_vol = cyl_vol - hem_vol
    return (inner_radius/2 * cyl_vol - (3*outer_radius/8) * hem_vol) / annular_vol

def _find_hemisphere_fill_height_for_moi(target_mass, radius, density):
    """Find fill height for given mass in hemisphere"""
    def equation(h):
        volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
        mass = volume * density
        return mass - target_mass
    
    h_solution = fsolve(equation, [radius * 0.5], xtol=1e-9, maxfev=1000)
    return min(h_solution[0], radius)

def calculate_dynamic_top_propellant_moment_of_inertia_s12(current_top_propellant_mass, top_propellant_length, radius, tank_thickness, top_propellant_density, top_propellant_length_initial):
    """
    Calculate top propellant moment of inertia during flight.
    Top propellant has bottom hemisphere + cylinder + top hemisphere geometry.
    
    Returns:
    - 3x3 inertia tensor
    """
    top_propellant_radius = radius - tank_thickness
    hemisphere_volume = (2/3) * math.pi * top_propellant_radius**3
    hemisphere_mass = hemisphere_volume * top_propellant_density
    top_propellant_hemisphere_mass = (2/3) * math.pi * top_propellant_radius**3 * top_propellant_density
    
    # Determine fill state
    if top_propellant_length > top_propellant_radius:
        bottom_mass = hemisphere_mass
        
        if top_propellant_length <= top_propellant_length_initial - top_propellant_radius:
            # Top hemisphere empty, cylinder partially full
            top_mass = 0
            cylinder_mass = current_top_propellant_mass - bottom_mass
            
            # Current cylinder length
            cyl_volume = cylinder_mass / top_propellant_density
            cyl_length = cyl_volume / (math.pi * top_propellant_radius**2)
            
            # Calculate inertias
            bottom_inertia = calculate_hemisphere_moment_of_inertia(bottom_mass, top_propellant_radius, top_propellant_radius)
            cylinder_inertia = calculate_solid_cylinder_component_moment_of_inertia(cylinder_mass, cyl_length, top_propellant_radius)
            
            # COMs relative to bottom of propellant
            bottom_com = (3 * top_propellant_radius) / 8
            cylinder_com = top_propellant_radius + cyl_length / 2
            total_com = (bottom_mass * bottom_com + cylinder_mass * cylinder_com) / current_top_propellant_mass
            
            # Apply parallel axis theorem
            bottom_shifted = calculate_shifted_moment_of_inertia(bottom_inertia, bottom_mass, abs(total_com - bottom_com))
            cylinder_shifted = calculate_shifted_moment_of_inertia(cylinder_inertia, cylinder_mass, abs(total_com - cylinder_com))
            
            return np.array(bottom_shifted) + np.array(cylinder_shifted)
        else:
            # Top hemisphere partially full
            cylinder_length = top_propellant_length_initial - 2 * top_propellant_radius
            cylinder_mass = cylinder_length * math.pi * top_propellant_radius**2 * top_propellant_density
            top_mass = current_top_propellant_mass - bottom_mass - cylinder_mass
            
            # Calculate inertias
            bottom_inertia = calculate_hemisphere_moment_of_inertia(bottom_mass, top_propellant_radius, top_propellant_radius)
            cylinder_inertia = calculate_solid_cylinder_component_moment_of_inertia(cylinder_mass, cylinder_length, top_propellant_radius)
            
            # Find fill height for partial top hemisphere
            if top_mass < top_propellant_hemisphere_mass:
                def find_hemisphere_fill_height(target_mass, radius, density):
                    def equation(h):
                        volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
                        mass = volume * density
                        return mass - target_mass
                    h_solution = fsolve(equation, [radius * 0.5], xtol=1e-9, maxfev=1000)
                    return min(h_solution[0], radius)
                top_fill_height = find_hemisphere_fill_height(top_mass, top_propellant_radius, top_propellant_density)
                top_inertia = calculate_hemisphere_moment_of_inertia(top_mass, top_propellant_radius, top_fill_height)
            else:
                top_inertia = calculate_hemisphere_moment_of_inertia(top_mass, top_propellant_radius, top_propellant_radius)
            
            # COMs relative to bottom of propellant
            bottom_com = (3 * top_propellant_radius) / 8
            cylinder_com = top_propellant_radius + cylinder_length / 2
            top_com = top_propellant_radius + cylinder_length + (5 * top_propellant_radius) / 8
            
            # Total COM
            total_com = (bottom_mass * bottom_com + cylinder_mass * cylinder_com + top_mass * top_com) / current_top_propellant_mass
            
            # Apply parallel axis theorem
            bottom_shifted = calculate_shifted_moment_of_inertia(bottom_inertia, bottom_mass, abs(total_com - bottom_com))
            cylinder_shifted = calculate_shifted_moment_of_inertia(cylinder_inertia, cylinder_mass, abs(total_com - cylinder_com))
            top_shifted = calculate_shifted_moment_of_inertia(top_inertia, top_mass, abs(total_com - top_com))
            
            return np.array(bottom_shifted) + np.array(cylinder_shifted) + np.array(top_shifted)
    else:
        # Only bottom hemisphere has propellant
        def find_hemisphere_fill_height(target_mass, radius, density):
            """Find fill height for given mass in hemisphere"""
            def equation(h):
                volume = math.pi * h[0]**2 * (3*radius - h[0]) / 3
                mass = volume * density
                return mass - target_mass
            
            h_solution = fsolve(equation, [radius * 0.5], xtol=1e-9, maxfev=1000)
            return min(h_solution[0], radius)
        
        fill_height = find_hemisphere_fill_height(current_top_propellant_mass, top_propellant_radius, top_propellant_density)
        return calculate_hemisphere_moment_of_inertia(current_top_propellant_mass, top_propellant_radius, fill_height)

# ================================================================
# TANK STRUCTURE MOI CALCULATIONS
# ================================================================

def calculate_stage_bottom_tank_moment_of_inertia(tank_mass, fuel_length, radius, stage_num, tank_head_mass=30):
    """
    Calculate bottom tank MOI including tank heads.
    For stages 1&2: cylinder + 1 hemisphere
    For stage 3: full sphere
    
    Args:
        tank_head_mass: Mass of tank head (kg), from config file
    """
    if stage_num == 3:
        # Stage 3: spherical shell
        I_sphere = (2/3) * tank_mass * radius**2
        return np.array([
            [I_sphere, 0, 0],
            [0, I_sphere, 0],
            [0, 0, I_sphere]
        ])
    else:
        # Stages 1&2: cylinder + 1 hemisphere
        cylinder_mass = tank_mass - tank_head_mass
        
        # Calculate component MOIs
        cylinder_moi = calculate_hollow_cylinder_component_moment_of_inertia(cylinder_mass, fuel_length, radius)
        hemisphere_moi = calculate_hemispherical_shell_moment_of_inertia(tank_head_mass, radius)
        
        return cylinder_moi + hemisphere_moi

def calculate_shifted_moment_of_inertia(inertia_matrix, mass, distance):
    """
    Apply parallel axis theorem to shift moment of inertia.
    For components stacked along x-axis (longitudinal axis).
    """
    I_xx = inertia_matrix[0, 0]
    I_yy = inertia_matrix[1, 1] 
    I_zz = inertia_matrix[2, 2]
    
    # Apply parallel axis theorem
    I_xx_shifted = I_xx  # No change for rotation about x-axis
    I_yy_shifted = I_yy + mass * distance**2
    I_zz_shifted = I_zz + mass * distance**2
    
    shifted_matrix = np.array([
        [I_xx_shifted, 0, 0],
        [0, I_yy_shifted, 0],
        [0, 0, I_zz_shifted]
    ])
    
    return shifted_matrix

def calculate_distances_from_reference(component_coms, reference_com):
    """Calculate distances for parallel axis theorem from component COMs to reference COM."""
    return {name: abs(com - reference_com) for name, com in component_coms.items()} 

def create_component(com, tensor, mass):
    """Helper to create component dictionary entries."""
    return {'com': com, 'tensor': tensor, 'mass': mass}

def calculate_ox_com_with_hemisphere(ox_mass, ox_length, radius, tank_thickness, ox_density, base_position):
    """
    Calculate the center of mass for oxidizer with cylinder+hemisphere geometry
    
    Parameters:
    - ox_mass: Current oxidizer mass
    - ox_length: Total oxidizer tank length (including hemisphere)
    - radius: Tank radius
    - tank_thickness: Wall thickness
    - ox_density: Oxidizer density (kg/m³)
    - base_position: Position of the bottom of the oxidizer tank
    
    Returns:
    - com: Center of mass position relative to stage top
    """
    ox_radius = radius - tank_thickness
    
    # Calculate how oxidizer is distributed
    hemisphere_volume = (2/3) * math.pi * ox_radius**3
    hemisphere_mass = hemisphere_volume * ox_density
    
    if ox_mass <= hemisphere_mass:
        # Oxidizer only partially fills hemisphere
        return base_position + ox_length - (3 * ox_radius) / 8
    
    # Calculate cylinder mass and current length
    cylinder_mass = ox_mass - hemisphere_mass
    cylinder_volume = cylinder_mass / ox_density
    current_cyl_length = cylinder_volume / (math.pi * ox_radius**2)
    
    # Calculate component COMs relative to oxidizer tank bottom
    cylinder_com = current_cyl_length / 2
    hemisphere_com = current_cyl_length + (3 * ox_radius) / 8
    
    # Calculate total COM
    total_com = (cylinder_mass * cylinder_com + hemisphere_mass * hemisphere_com) / ox_mass
    
    return base_position + total_com

def calculate_stage_top_tank_moment_of_inertia(ox_tank_mass, ox_length, radius, stage_num, tank_head_mass=30):
    """
    Calculate top tank moment of inertia including tank heads.
    For stages 1&2: cylinder + 2 hemispheres
    For stage 3: full sphere
    
    Args:
        tank_head_mass: Mass of tank head (kg), from config file
    
    Returns:
    - inertia_matrix: 3x3 numpy array
    """
    if stage_num == 3:
        # Stage 3: spherical shell
        I_sphere = (2/3) * ox_tank_mass * radius**2
        inertia_matrix = np.array([
            [I_sphere, 0, 0],
            [0, I_sphere, 0],
            [0, 0, I_sphere]
        ])
        return inertia_matrix
    else:
        # Stages 1&2: cylinder + 2 hemispheres
        cylinder_mass = ox_tank_mass - 2 * tank_head_mass
        
        # Calculate component MOIs
        cylinder_moi = calculate_hollow_cylinder_component_moment_of_inertia(cylinder_mass, ox_length, radius)
        hemisphere_moi = calculate_hemispherical_shell_moment_of_inertia(2 * tank_head_mass, radius)
        
        return cylinder_moi + hemisphere_moi

# ================================================================
# STAGE 3 SPECIFIC DYNAMIC CALCULATIONS
# ================================================================

def calculate_dynamic_bottom_propellant_moment_of_inertia_s3(current_bottom_propellant_mass, bottom_propellant_length, radius, tank_thickness, bottom_propellant_density):
    """
    Calculate bottom propellant moment of inertia for stage 3 spherical tank during flight.
    
    Returns:
    - 3x3 inertia tensor
    """
    bottom_propellant_radius = radius - tank_thickness
    R = bottom_propellant_radius
    h = min(bottom_propellant_length, 2 * R)
    
    if h >= 2 * R - 1e-6:
        # Full sphere
        I_sphere = (2/5) * current_bottom_propellant_mass * R**2
        return np.array([
            [I_sphere, 0, 0],
            [0, I_sphere, 0],
            [0, 0, I_sphere]
        ])
    
    # Partially filled sphere
    z_cm = h * (4*R - h) / (4 * (3*R - h))
    z_from_center = z_cm - R
    fill_fraction = h / (2 * R)
    
    # Calculate moments of inertia
    I_radial = current_bottom_propellant_mass * (0.4 * R**2 * fill_fraction**2 + z_from_center**2)
    I_axial = current_bottom_propellant_mass * 0.4 * R**2 * fill_fraction
    
    return np.array([
        [I_radial, 0, 0],
        [0, I_radial, 0],
        [0, 0, I_axial]
    ])

def calculate_dynamic_top_propellant_moment_of_inertia_s3(current_top_propellant_mass, top_propellant_length, radius, tank_thickness, top_propellant_density):
    """
    Calculate top propellant moment of inertia for stage 3 spherical tank during flight.
    
    Returns:
    - 3x3 inertia tensor
    """
    top_propellant_radius = radius - tank_thickness
    R = top_propellant_radius
    h = min(top_propellant_length, 2 * R)
    
    if h >= 2 * R - 1e-6:
        # Full sphere
        I_sphere = (2/5) * current_top_propellant_mass * R**2
        return np.array([
            [I_sphere, 0, 0],
            [0, I_sphere, 0],
            [0, 0, I_sphere]
        ])
    
    # Partially filled sphere - calculate MOI components
    V_cap = math.pi * h**2 * (3*R - h) / 3
    y_com = (3*(2*R - h)**2) / (4*(3*R - h))
    
    m = current_top_propellant_mass
    
    # MOI formulas for spherical cap about its COM
    I_xx = m * R**2 * (0.4 - (h*(3*R - h))/(5*R**2) + h**2*(2*R - h)**2/(4*R**2*(3*R - h)**2))
    I_yy = I_xx
    I_zz = m * R**2 * (2/5 - h*(3*R - h)/(5*R**2))
    
    return np.array([
        [I_xx, 0, 0],
        [0, I_yy, 0],
        [0, 0, I_zz]
    ])

def calculate_stage_top_propellant_moment_of_inertia(top_propellant_mass, top_propellant_length, radius, tank_thickness, top_propellant_density, stage_num):
    """
    Calculate top propellant MOI for static (full tank) case
    """
    if stage_num == 3:
        # Stage 3: Use spherical tank function
        top_propellant_volume = top_propellant_mass / top_propellant_density
        
        return calculate_stage3_propellant_moment_of_inertia(
            propellant_mass=top_propellant_mass,
            propellant_volume=top_propellant_volume,
            tank_radius=radius,
            tank_thickness=tank_thickness,
            propellant_density=top_propellant_density,
            is_bottom_propellant=False
        )
    else:
        # Stages 1&2: Use dynamic function with full tank parameters
        return calculate_dynamic_top_propellant_moment_of_inertia_s12(
            top_propellant_mass,
            top_propellant_length,
            radius,
            tank_thickness,
            top_propellant_density,
            top_propellant_length
        )