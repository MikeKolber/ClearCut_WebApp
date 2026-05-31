import yaml
from pathlib import Path
import numpy as np
import math
import os

from .moment_of_inertia_functions import calculate_component_com
from .moment_of_inertia_functions import calculate_solid_cylinder_component_moment_of_inertia
from .moment_of_inertia_functions import calculate_hollow_cylinder_component_moment_of_inertia
from .moment_of_inertia_functions import calculate_hollow_cylinder_with_radii_moment_of_inertia
from .moment_of_inertia_functions import calculate_shifted_moment_of_inertia   
from .moment_of_inertia_functions import calculate_distances_from_reference
from .moment_of_inertia_functions import create_component
from .moment_of_inertia_functions import calculate_stage_bottom_propellant_moment_of_inertia
from .moment_of_inertia_functions import calculate_stage_bottom_tank_moment_of_inertia
from .moment_of_inertia_functions import calculate_stage_top_propellant_moment_of_inertia
from .moment_of_inertia_functions import calculate_stage_top_tank_moment_of_inertia
from .moment_of_inertia_functions import calculate_current_fuel_and_ox_masses_and_lengths_stages12
from .moment_of_inertia_functions import calculate_current_fuel_and_ox_masses_and_lengths_stage3
from .moment_of_inertia_functions import calculate_hemisphere_moment_of_inertia
from .moment_of_inertia_functions import calculate_stage3_propellant_moment_of_inertia
from .moment_of_inertia_functions import calculate_fuel_cylinder_length


class StaticMomentOfInertia:
    """
    Calculate and store static moment of inertia components from YAML configuration.
    
    This class performs a complete static analysis of a multi-stage rocket's moment of inertia:
    
    1. DATA LOADING: Reads rocket configuration from YAML file
    2. PARAMETER EXTRACTION: Extracts and organizes parameters for each component
    3. GEOMETRY CALCULATION: Calculates dimensions and properties for each stage
    4. CENTER OF MASS: Computes COM for individual components and assemblies
    5. MOMENT OF INERTIA: Calculates MOI tensors for each component
    6. REFERENCE FRAME SHIFTING: Shifts all MOIs to common reference frames
    7. TOTAL CALCULATIONS: Sums components for different flight configurations
    
    The class stores all intermediate and final results as instance attributes for easy access.
    
    Key Configurations Calculated:
    - Stage 1 (full rocket): All three stages + payload + fairing
    - Stage 2 (after stage 1 separation): Stages 2&3 + payload + fairing  
    - Stage 3 (after stage 2 separation): Stage 3 + payload (no fairing)
    - Stage 3 empty: Stage 3 structure only (no propellant, no payload)
    """
    
    # Define constants for clarity
    STAGE_NUMBERS = [1, 2, 3]
    COMPONENT_TYPES = ['engine', 'bottom_propellant', 'top_propellant', 'bottom_tank', 'top_tank']
    
    # Component MOI calculation configurations
    COMPONENT_MOI_CONFIGS = {
        'engine': {
            'calc_func': calculate_hollow_cylinder_with_radii_moment_of_inertia,
            'params': lambda self, num: (
                getattr(self, f'stage{num}_engine_mass_total'),
                getattr(self, f'stage{num}_engine_length'),
                getattr(self, f'stage{num}_engine_inner_radius'),
                getattr(self, f'stage{num}_engine_outer_radius')
            )
        },
        'bottom_propellant': {
            'calc_func': calculate_stage_bottom_propellant_moment_of_inertia,
            'params': lambda self, num: (
                getattr(self, f'stage{num}_bottom_propellant_mass'),
                getattr(self, f'stage{num}_radius'),
                getattr(self, f'stage{num}_tank_thickness'),
                getattr(self, f'stage{num}_bottom_propellant_density'),
                num 
            )
        },
        'top_propellant': {
            'calc_func': calculate_stage_top_propellant_moment_of_inertia,
            'params': lambda self, num: (
                getattr(self, f'stage{num}_top_propellant_mass'),
                getattr(self, f'stage{num}_top_propellant_length'),
                getattr(self, f'stage{num}_radius'),
                getattr(self, f'stage{num}_tank_thickness'),
                getattr(self, f'stage{num}_top_propellant_density'),
                num
            )
        },
        'bottom_tank': {
            'calc_func': calculate_stage_bottom_tank_moment_of_inertia,
            'params': lambda self, num: (
                getattr(self, f'stage{num}_bottom_tank_mass'),
                getattr(self, f'stage{num}_bottom_propellant_length'),
                getattr(self, f'stage{num}_radius'),
                num,
                getattr(self, f'stage{num}_tank_head_mass')
            )
        },
        'top_tank': {
            'calc_func': calculate_stage_top_tank_moment_of_inertia,
            'params': lambda self, num: (
                getattr(self, f'stage{num}_top_tank_mass'),
                getattr(self, f'stage{num}_top_propellant_length'),
                getattr(self, f'stage{num}_radius'),
                num,
                getattr(self, f'stage{num}_tank_head_mass')
            )
        }
    }
    
    def __init__(self):
        """
        Initialize and calculate all static moment of inertia data.
        
        The initialization follows a specific sequence where each step
        depends on the previous ones. The flow is:
        Configuration → Geometry → Mass Properties → MOI → Reference Frames
        """
        
        # ========== STEP 1: LOAD CONFIGURATION ==========
        self._load_yaml_data()
        self._extract_parameters()
        
        # ========== STEP 2: CALCULATE GEOMETRY ==========
        self._calculate_stage_properties()
        
        # ========== STEP 3: CALCULATE MASS PROPERTIES ==========
        self._calculate_component_coms()      # Individual component COMs
        self._calculate_stage_coms()          # Combined stage COMs
        self._calculate_full_rocket_properties()  # Full rocket COM
        
        # ========== STEP 4: CALCULATE MOMENT OF INERTIA ==========
        self._calculate_moment_of_inertia_tensors()  # Local MOI for each component
        
        # ========== STEP 5: SHIFT TO REFERENCE FRAMES ==========
        self._calculate_distances()           # Distances from reference COMs
        self._calculate_shifted_tensors()     # Apply parallel axis theorem
        
        # ========== STEP 6: CALCULATE TOTALS ==========
        self._calculate_total_tensors()       # Sum for each configuration
        
        # ========== STEP 7: OUTPUT ==========
        self.print_component_lengths()
        
        
    # ================================================================
    # SECTION 1: DATA LOADING AND PARAMETER EXTRACTION
    # ================================================================
        
    def _load_yaml_data(self):
        """Load rocket structure data from YAML file"""
        yaml_path = Path(__file__).parent.parent.parent / '../json_files/rocket_structure/rocket_structure.yaml'
        with open(yaml_path, 'r') as f:
            self.data = yaml.safe_load(f)

        self.stage1 = self.data['Stage 1']
        self.stage2 = self.data['Stage 2']
        self.stage3 = self.data['Stage 3']
        
    def _extract_parameters(self):
        """Extract and assign parameters from YAML data"""
        # Load parameter groups
        [setattr(self, g.replace('_parameters', '_params'), self.data[g]) for g in 
            ['tank_parameters', 'interstage_parameters', 'fairing_parameters', 'error_handling', 'engine_parameters', 'payload_parameters', 'number_of_engines']]
        
        # Stage-specific parameters
        [[setattr(self, attr, val) for attr, val in [
            (f'number_of_engines_stage{i}', self.number_of_engines[f'stage{i}_number_of_engines']),
            (f'stage{i}_tank_head_length', getattr(self, f'stage{i}')['Tank Head length [m]']),
            (f'stage{i}_engine_mass', self.engine_params[f'stage{i}_engine_mass_kg']),
            (f'stage{i}_engine_mass_total', self.engine_params[f'stage{i}_engine_mass_kg'] * self.number_of_engines[f'stage{i}_number_of_engines'])
        ]] for i in self.STAGE_NUMBERS]
        
        # Direct parameter assignments
        self.__dict__.update({
            'fuel_tank_mass_ratio': self.tank_params['fuel_tank_mass_ratio'],
            'ox_tank_mass_ratio': self.tank_params['oxidizer_tank_mass_ratio'],
            'fuel_tank_head_mass': self.tank_params['fuel_tank_head_mass'],
            'tank_thickness': self.tank_params['tank_thickness_m'],
            'default_engine_length': self.error_handling['default_engine_length_m'],
            **{f'stage{s}_interstage_{t}': self.interstage_params[f'stage{s}_interstage'][f'{t}_{"kg" if t == "mass" else "m"}'] 
                for s in ['12', '23'] for t in ['mass', 'length']},
            **{f'{p}_{t}': self.__dict__[f'{p}_params'][f'{t}_{"kg" if t == "mass" else "m"}'] 
                for p in ['fairing', 'payload'] for t in ['mass', 'radius', 'length']}
        })
        
    def _calculate_stage_properties(self):
        """Calculate derived stage properties from basic parameters"""
        stages = [self.stage1, self.stage2, self.stage3]
        
        for num, stage in enumerate(stages, 1):
            # Get propellant order for this stage
            propellant_order = stage.get('propellant_order', 'fuel_first')
            setattr(self, f'stage{num}_propellant_order', propellant_order)
            
            # Extract basic properties from YAML
            fuel_mass = stage['Fuel. Mass [kg]']
            ox_mass = stage['Ox. Mass [kg]']
            fuel_density = stage['Fuel. Density [kg/m^3]']
            ox_density = stage['Ox. Density [kg/m^3]']
            ox_volume = stage['Ox. Volume [m^3]']
            
            if propellant_order == 'fuel_first':
                # Fuel is at bottom, ox is at top
                props = {
                    'max_diameter': stage['Stage Max Diameter [m]'],
                    'bottom_propellant_mass': fuel_mass,
                    'top_propellant_mass': ox_mass,
                    'bottom_propellant_density': fuel_density,
                    'top_propellant_density': ox_density,
                    'top_propellant_volume': ox_volume
                }
            else:
                # Ox is at bottom, fuel is at top
                props = {
                    'max_diameter': stage['Stage Max Diameter [m]'],
                    'bottom_propellant_mass': ox_mass,
                    'top_propellant_mass': fuel_mass,
                    'bottom_propellant_density': ox_density,
                    'top_propellant_density': fuel_density,
                    'top_propellant_volume': fuel_mass / fuel_density  # Calculate fuel volume
                }
            
            # Set basic properties
            for prop, value in props.items():
                setattr(self, f'stage{num}_{prop}', value)
            
            # Calculate derived properties
            radius = props['max_diameter'] / 2
            bottom_propellant_volume = props['bottom_propellant_mass'] / props['bottom_propellant_density']
            area = math.pi * (radius - self.tank_thickness)**2
            
            setattr(self, f'stage{num}_radius', radius)
            setattr(self, f'stage{num}_bottom_propellant_volume', bottom_propellant_volume)
            
            # Calculate fuel tank dimensions based on stage configuration
            if num in [1, 2]:
                # Stages 1&2: hemisphere + cylinder + inverted bulkhead + extension to bulkhead base
                hemisphere_vol = (2/3) * math.pi * radius**3
                
                # Fuel around inverted oxidizer bulkhead
                inner_radius = radius - self.tank_thickness
                fuel_around_ox_cylinder_vol = math.pi * inner_radius**3
                ox_inverted_hemisphere_vol = (2/3) * math.pi * radius**3
                fuel_around_ox_vol = fuel_around_ox_cylinder_vol - ox_inverted_hemisphere_vol
                
                total_non_cylinder_vol = hemisphere_vol + fuel_around_ox_vol
                
                cylinder_vol = bottom_propellant_volume - total_non_cylinder_vol
                if cylinder_vol > 0:
                    cylinder_length = cylinder_vol / area
                    # Add extra radius to extend to base hemisphere of bulkhead
                    bottom_propellant_tank_length = radius + cylinder_length + radius
                else:
                    print("\n-----------------------------------------------------------------------")
                    print(f"ERROR: Cylinder volume for stage {num} is negative - should not happen")
                    print("-----------------------------------------------------------------------\n")
                    
                    bottom_propellant_tank_length = radius + radius
                    print(f"bottom_propellant_tank_length: {bottom_propellant_tank_length}")
                    print(f"cylinder_length: {cylinder_length}")
                    print(f"radius: {radius}")

            else:
                # Stage 3: sphere
                inner_radius = radius - self.tank_thickness
                # Use stage radius minus tank thickness for both spheres
                bottom_propellant_tank_length = 2 * inner_radius
            
            setattr(self, f'stage{num}_bottom_propellant_length', bottom_propellant_tank_length)
            
            # Calculate oxidizer tank dimensions
            if num in [1, 2]:
                # Stages 1&2: cylinder+hemisphere
                inner_radius = radius - self.tank_thickness
                hemisphere_vol = (2/3) * math.pi * inner_radius**3
                cylinder_vol = props['top_propellant_volume'] - hemisphere_vol * 2
                if cylinder_vol > 0:
                    cylinder_length = cylinder_vol / area
                    top_propellant_tank_length = cylinder_length + radius * 2
                else:
                    top_propellant_tank_length = radius * 2
            else:
                # Stage 3: sphere
                # Use stage radius minus tank thickness for both spheres
                inner_radius = radius - self.tank_thickness
                top_propellant_tank_length = 2 * inner_radius
            
            setattr(self, f'stage{num}_top_propellant_length', top_propellant_tank_length)
            setattr(self, f'stage{num}_engine_length', self.engine_params[f'stage{num}_engine_length_m3'])
            
            # O/F ratio
            of_key = 'Propellants O/F ratio' if num == 1 else 'O/F Ratio'
            setattr(self, f'stage{num}_of_ratio', stage[of_key])
            
            # Tank masses
            setattr(self, f'stage{num}_bottom_tank_mass', props['bottom_propellant_mass'] * self.fuel_tank_mass_ratio + self.fuel_tank_head_mass)
            setattr(self, f'stage{num}_top_tank_mass', props['top_propellant_mass'] * self.ox_tank_mass_ratio + 2 * self.fuel_tank_head_mass)
            setattr(self, f'stage{num}_tank_head_mass', self.fuel_tank_head_mass)
            setattr(self, f'stage{num}_tank_thickness', self.tank_thickness)
            
            # Calculate total stage length
            calculated_length = (2 * self.tank_thickness + 
                                getattr(self, f'stage{num}_top_propellant_length') + 
                                getattr(self, f'stage{num}_bottom_propellant_length') + 
                                getattr(self, f'stage{num}_engine_length'))
            setattr(self, f'stage{num}_calculated_length', calculated_length)
            self.__dict__[f'stage{num}_length'] = calculated_length
        
        # Set engine radii
        engine_radii = self.data['engine_parameters']
        for num in self.STAGE_NUMBERS:
            setattr(self, f'stage{num}_engine_inner_radius', engine_radii['engine_inner_radius_m'])
            setattr(self, f'stage{num}_engine_outer_radius', engine_radii['engine_outer_radius_m'])
            
    # ================================================================
    # SECTION 2: CENTER OF MASS CALCULATIONS
    # ================================================================
        
    def _calculate_component_coms(self):
        """Calculate center of mass for all individual components"""
        # Offsets are distance from TOP of rocket to TOP of each stage
        offsets = [
            self.payload_length + self.stage3_length + self.stage2_length,  # Stage 1 top
            self.payload_length + self.stage3_length,                       # Stage 2 top
            self.payload_length                                             # Stage 3 top
        ]
        
        for i, (num, offset) in enumerate(zip(self.STAGE_NUMBERS, offsets)):
            # Calculate fuel and ox base positions FROM TOP OF STAGE
            # Stage layout from top: top_tank -> bottom_tank -> engine
            
            if getattr(self, f'stage{num}_propellant_order') == "fuel_first":
                # From top: top propellant starts at top (0), bottom propellant starts after top
                top_propellant_base_position = self.tank_thickness  # Top propellant at top of stage
                bottom_propellant_base_position = self.tank_thickness * 2 + getattr(self, f'stage{num}_top_propellant_length')  # Bottom starts after top
            else:
                # This case shouldn't happen based on the physical layout described
                # But keeping for compatibility
                bottom_propellant_base_position = self.tank_thickness
                top_propellant_base_position = self.tank_thickness * 2 + getattr(self, f'stage{num}_bottom_propellant_length')
            
            # Calculate propellant COMs using the same functions as dynamic
            total_propellant_mass = getattr(self, f'stage{num}_bottom_propellant_mass') + getattr(self, f'stage{num}_top_propellant_mass')
            
            if num in [1, 2]:
                # Use the same function as dynamic for stages 1&2
                # Get original fuel and ox data (before propellant_order mapping)
                fuel_mass = self.__dict__[f'stage{num}']['Fuel. Mass [kg]']
                ox_mass = self.__dict__[f'stage{num}']['Ox. Mass [kg]']
                fuel_volume = fuel_mass / self.__dict__[f'stage{num}']['Fuel. Density [kg/m^3]']
                ox_volume = self.__dict__[f'stage{num}']['Ox. Volume [m^3]']
                
                # Get initial lengths based on propellant order
                if getattr(self, f'stage{num}_propellant_order') == 'fuel_first':
                    fuel_length_initial = getattr(self, f'stage{num}_bottom_propellant_length')
                    ox_length_initial = getattr(self, f'stage{num}_top_propellant_length')
                else:
                    fuel_length_initial = getattr(self, f'stage{num}_top_propellant_length')
                    ox_length_initial = getattr(self, f'stage{num}_bottom_propellant_length')
                
                _, _, bottom_propellant_length, top_propellant_length, bottom_propellant_com_from_top, top_propellant_com_from_top = \
                    calculate_current_fuel_and_ox_masses_and_lengths_stages12(
                        total_propellant_mass,
                        getattr(self, f'stage{num}_of_ratio'),
                        fuel_mass,
                        fuel_volume,
                        ox_mass,
                        ox_volume,
                        getattr(self, f'stage{num}_radius'),
                        getattr(self, f'stage{num}_tank_thickness'),
                        fuel_length_initial,
                        ox_length_initial,
                        getattr(self, f'stage{num}_tank_head_length'),
                        getattr(self, f'stage{num}_propellant_order')
                    )
            else:
                # Stage 3: Use the same function as dynamic for stage 3
                # Get original fuel and ox data (before propellant_order mapping)
                fuel_mass = self.__dict__[f'stage{num}']['Fuel. Mass [kg]']
                ox_mass = self.__dict__[f'stage{num}']['Ox. Mass [kg]']
                fuel_volume = fuel_mass / self.__dict__[f'stage{num}']['Fuel. Density [kg/m^3]']
                ox_volume = self.__dict__[f'stage{num}']['Ox. Volume [m^3]']
                
                # Get initial lengths based on propellant order
                if getattr(self, f'stage{num}_propellant_order') == 'fuel_first':
                    fuel_length_initial = getattr(self, f'stage{num}_bottom_propellant_length')
                    ox_length_initial = getattr(self, f'stage{num}_top_propellant_length')
                else:
                    fuel_length_initial = getattr(self, f'stage{num}_top_propellant_length')
                    ox_length_initial = getattr(self, f'stage{num}_bottom_propellant_length')
                
                _, _, bottom_propellant_length, top_propellant_length, bottom_propellant_com_from_top, top_propellant_com_from_top = \
                    calculate_current_fuel_and_ox_masses_and_lengths_stage3(
                        total_propellant_mass,
                        getattr(self, f'stage{num}_of_ratio'),
                        fuel_mass,
                        fuel_volume,
                        ox_mass,
                        ox_volume,
                        getattr(self, f'stage{num}_radius'),
                        getattr(self, f'stage{num}_tank_thickness'),
                        fuel_length_initial,
                        ox_length_initial,
                        getattr(self, f'stage{num}_tank_head_length'),
                        getattr(self, f'stage{num}_propellant_order')
                    )
            
            # COMs are relative to TOP of stage (will add offset later)
            bottom_propellant_com_rel = bottom_propellant_com_from_top
            top_propellant_com_rel = top_propellant_com_from_top
            
            # Get component COMs relative to stage top
            engine_com, _, _, bottom_tank_com, top_tank_com = calculate_component_com(
                getattr(self, f'stage{num}_engine_length'),
                getattr(self, f'stage{num}_bottom_propellant_length'),  # bottom_propellant_length_initial
                bottom_propellant_length,  # bottom_propellant_length_current (from propellant distribution function)
                getattr(self, f'stage{num}_top_propellant_length'),  # top_propellant_length_initial
                top_propellant_length,  # top_propellant_length_current (from propellant distribution function)
                getattr(self, f'stage{num}_tank_head_length'),
                getattr(self, f'stage{num}_propellant_order'),
                num,
                getattr(self, f'stage{num}_tank_thickness'),
                bottom_propellant_com_rel,  # bottom_propellant_com
                top_propellant_com_rel,  # top_propellant_com
                getattr(self, f'stage{num}_radius')  # stage_radius
            )
            
            # Use the COMs from propellant distribution functions
            bottom_propellant_com = bottom_propellant_com_rel
            top_propellant_com = top_propellant_com_rel
            
            # Set all COMs (absolute positions from TOP of rocket)
            setattr(self, f'stage{num}_engine_com', offset + engine_com)
            setattr(self, f'stage{num}_bottom_propellant_com', offset + bottom_propellant_com)
            setattr(self, f'stage{num}_top_propellant_com', offset + top_propellant_com)
            setattr(self, f'stage{num}_bottom_tank_com', offset + bottom_tank_com)
            setattr(self, f'stage{num}_top_tank_com', offset + top_tank_com)
            
    def _calculate_stage_coms(self):
        """Calculate stage centers of mass"""
        for num in self.STAGE_NUMBERS:
            total_mass = 0
            weighted_com = 0
            
            for comp in self.COMPONENT_TYPES:
                com = getattr(self, f'stage{num}_{comp}_com')
                if comp == 'engine':
                    mass = getattr(self, f'stage{num}_engine_mass_total')
                else:
                    mass = getattr(self, f'stage{num}_{comp}_mass')
                weighted_com += com * mass
                total_mass += mass
            
            setattr(self, f'stage{num}_com', weighted_com / total_mass)
            setattr(self, f'stage{num}_total_mass', total_mass)

        self.fairing_static_com = self.fairing_length / 2
        self.payload_com = self.payload_length / 2
        
        # Calculate absolute positions FROM TOP OF ROCKET
        print(f"stage1_length: {self.stage1_length}")
        print(f"stage2_length: {self.stage2_length}")
        print(f"stage3_length: {self.stage3_length}")
        print(f"stage12_interstage_length: {self.stage12_interstage_length}")
        print(f"stage23_interstage_length: {self.stage23_interstage_length}")
        print(f"fairing_length: {self.fairing_length}")
        print(f"payload_length: {self.payload_length}")
        
        # Stage COMs are already absolute from top (calculated in _calculate_component_coms)
        self.stage1_absolute_com = self.stage1_com 
        self.stage2_absolute_com = self.stage2_com
        self.stage3_absolute_com = self.stage3_com
        
        # Interstage COMs from top of rocket
        self.stage12_interstage_absolute_com = self.payload_length + self.stage3_length + self.stage2_length - self.stage12_interstage_length / 2    
        self.stage23_interstage_absolute_com = self.payload_length + self.stage3_length - self.stage23_interstage_length / 2
        
        # Fairing and payload from top
        self.fairing_absolute_com = self.fairing_length / 2 
        self.payload_absolute_com = self.payload_length / 2

        print(f"stage1_absolute_com: {self.stage1_absolute_com}")
        print(f"stage2_absolute_com: {self.stage2_absolute_com}")
        print(f"stage3_absolute_com: {self.stage3_absolute_com}")
        print(f"stage12_interstage_absolute_com: {self.stage12_interstage_absolute_com}")
        print(f"stage23_interstage_absolute_com: {self.stage23_interstage_absolute_com}")
        print(f"fairing_absolute_com: {self.fairing_absolute_com}")
        print(f"payload_absolute_com: {self.payload_absolute_com}")
        
    def _calculate_full_rocket_properties(self):
        """Calculate full rocket mass and COM for each configuration"""
        # Stage 1 configuration (full rocket)
        self.stage1_full_rocket_mass = (self.stage1_total_mass + self.stage12_interstage_mass + self.stage2_total_mass + 
                                        self.stage23_interstage_mass + self.stage3_total_mass + self.fairing_mass + self.payload_mass)
        self.stage1_full_rocket_com = (self.stage1_absolute_com * self.stage1_total_mass + 
                                self.stage12_interstage_absolute_com * self.stage12_interstage_mass +
                                self.stage2_absolute_com * self.stage2_total_mass +
                                self.stage23_interstage_absolute_com * self.stage23_interstage_mass +
                                self.stage3_absolute_com * self.stage3_total_mass +
                                self.fairing_absolute_com * self.fairing_mass +
                                self.payload_com * self.payload_mass) / self.stage1_full_rocket_mass
        self.freefall_full_rocket_com = self.stage1_full_rocket_com
        
        # Interstage 1-2 configuration (after stage 1 and interstage 1-2 have been jettisoned)
        self.interstage12_full_rocket_mass = (self.stage2_total_mass + self.stage23_interstage_mass + self.stage3_total_mass + self.fairing_mass + self.payload_mass)
        self.interstage12_full_rocket_com = (self.stage2_absolute_com * self.stage2_total_mass +
                                        self.stage23_interstage_absolute_com * self.stage23_interstage_mass +
                                        self.stage3_absolute_com * self.stage3_total_mass +
                                        self.fairing_absolute_com * self.fairing_mass +
                                        self.payload_com * self.payload_mass) / self.interstage12_full_rocket_mass
        
        # Stage 2 configuration
        self.stage2_full_rocket_mass = (self.stage2_total_mass + self.stage23_interstage_mass + self.stage3_total_mass + self.fairing_mass + self.payload_mass)
        self.stage2_full_rocket_com = (self.stage2_absolute_com * self.stage2_total_mass +
                                self.stage23_interstage_absolute_com * self.stage23_interstage_mass +
                                self.stage3_absolute_com * self.stage3_total_mass +
                                self.fairing_absolute_com * self.fairing_mass +
                                self.payload_com * self.payload_mass) / self.stage2_full_rocket_mass
        
        # Interstage 2-3 configuration (after stage 2 and interstage 2-3 have been jettisoned)
        self.interstage23_full_rocket_mass = (self.stage3_total_mass + self.fairing_mass + self.payload_mass)
        self.interstage23_full_rocket_com = (self.stage3_absolute_com * self.stage3_total_mass +
                                        self.fairing_absolute_com * self.fairing_mass +
                                        self.payload_com * self.payload_mass) / self.interstage23_full_rocket_mass
        
        # DEBUG: Print interstage23 calculation
        print(f"\n=== STATIC INTERSTAGE23 ROCKET COM ===")
        print(f"Stage3 COM: {self.stage3_absolute_com:.6f} m, mass: {self.stage3_total_mass:.2f} kg")
        print(f"Fairing COM: {self.fairing_absolute_com:.6f} m, mass: {self.fairing_mass:.2f} kg") 
        print(f"Payload COM: {self.payload_com:.6f} m, mass: {self.payload_mass:.2f} kg")
        print(f"Interstage23 full rocket COM: {self.interstage23_full_rocket_com:.6f} m")
        print(f"=====================================\n")

        # Stage 3 configuration
        self.stage3_full_rocket_mass = self.stage3_total_mass + self.fairing_mass + self.payload_mass
        self.stage3_full_rocket_com = (self.stage3_absolute_com * self.stage3_total_mass +
                                 self.fairing_absolute_com * self.fairing_mass +
                                 self.payload_com * self.payload_mass) / self.stage3_full_rocket_mass

        print(f"stage1_full_rocket_com: {self.stage1_full_rocket_com}")
        print(f"interstage12_full_rocket_com: {self.interstage12_full_rocket_com}")
        print(f"stage2_full_rocket_com: {self.stage2_full_rocket_com}")
        print(f"interstage23_full_rocket_com: {self.interstage23_full_rocket_com}")
        print(f"stage3_full_rocket_com: {self.stage3_full_rocket_com}")
    # ================================================================
    # SECTION 3: MOMENT OF INERTIA CALCULATIONS
    # ================================================================

    def _calculate_moment_of_inertia_tensors(self):
        """Calculate local moment of inertia tensors for each component about their own COMs"""
        # Calculate stage component tensors
        for num in self.STAGE_NUMBERS:
            for component, config in self.COMPONENT_MOI_CONFIGS.items():
                tensor = config['calc_func'](*config['params'](self, num))
                setattr(self, f'stage{num}_{component}_moment_of_inertia_tensor', tensor)
        
        # Calculate interstage tensors
        interstage_configs = [
            ('interstage12', self.stage12_interstage_mass, self.stage12_interstage_length, self.stage1_radius),
            ('interstage23', self.stage23_interstage_mass, self.stage23_interstage_length, self.stage2_radius)
        ]
        
        for name, mass, length, radius in interstage_configs:
            tensor = calculate_hollow_cylinder_component_moment_of_inertia(mass, length, radius)
            setattr(self, f'{name}_moment_of_inertia_tensor', tensor)
        
        # Calculate fairing and payload tensors
        self.fairing_moment_of_inertia_tensor = calculate_hollow_cylinder_component_moment_of_inertia(
            self.fairing_mass, self.fairing_length, self.fairing_radius)
        self.payload_moment_of_inertia_tensor = calculate_solid_cylinder_component_moment_of_inertia(
            self.payload_mass, self.payload_length, self.payload_radius)
        
    # ================================================================
    # SECTION 4: REFERENCE FRAME SHIFTING
    # ================================================================
        
    def _calculate_distances(self):
        """Calculate distances from components to reference COMs for parallel axis theorem"""
        # Define all component COMs
        component_coms = {
            'stage1_engine': self.stage1_engine_com,
            'stage1_bottom_propellant': self.stage1_bottom_propellant_com,
            'stage1_top_propellant': self.stage1_top_propellant_com,
            'stage1_bottom_tank': self.stage1_bottom_tank_com,
            'stage1_top_tank': self.stage1_top_tank_com,
            'interstage12': self.stage12_interstage_absolute_com,
            'stage2_engine': self.stage2_engine_com,
            'stage2_bottom_propellant': self.stage2_bottom_propellant_com,
            'stage2_top_propellant': self.stage2_top_propellant_com,
            'stage2_bottom_tank': self.stage2_bottom_tank_com,
            'stage2_top_tank': self.stage2_top_tank_com,
            'interstage23': self.stage23_interstage_absolute_com,
            'stage3_engine': self.stage3_engine_com,
            'stage3_bottom_propellant': self.stage3_bottom_propellant_com,
            'stage3_top_propellant': self.stage3_top_propellant_com,
            'stage3_bottom_tank': self.stage3_bottom_tank_com,
            'stage3_top_tank': self.stage3_top_tank_com,
            'fairing': self.fairing_absolute_com,
            'payload': self.payload_absolute_com,
        }

        # Calculate distances for each configuration
        configs = {
            'com1': (self.stage1_full_rocket_com, component_coms.keys()),
            'com12': (self.interstage12_full_rocket_com, component_coms.keys()),
            'com2': (self.stage2_full_rocket_com, component_coms.keys()),
            'com23': (self.interstage23_full_rocket_com, component_coms.keys()),
            'com3': (self.stage3_full_rocket_com, component_coms.keys())
        }
        
        for prefix, (ref_com, components) in configs.items():
            distances = calculate_distances_from_reference(component_coms, ref_com)
            for comp in components:
                # Handle special naming for fairing distances
                if prefix == 'com2' and comp == 'fairing':
                    setattr(self, f'{prefix}_to_stage2_fairing_distance', distances[comp])
                elif prefix == 'com3' and comp == 'fairing':
                    setattr(self, f'{prefix}_to_stage3_fairing_distance', distances[comp])
                else:
                    setattr(self, f'{prefix}_to_{comp}_distance', distances[comp])
        
    def _calculate_shifted_tensors(self):
        """Calculate shifted tensors using parallel axis theorem"""
        # Define all components
        components = {
            # Stage 1
            'stage1_engine': create_component(self.stage1_engine_com, self.stage1_engine_moment_of_inertia_tensor, self.stage1_engine_mass_total),
            'stage1_bottom_propellant': create_component(self.stage1_bottom_propellant_com, self.stage1_bottom_propellant_moment_of_inertia_tensor, self.stage1_bottom_propellant_mass),
            'stage1_top_propellant': create_component(self.stage1_top_propellant_com, self.stage1_top_propellant_moment_of_inertia_tensor, self.stage1_top_propellant_mass),
            'stage1_bottom_tank': create_component(self.stage1_bottom_tank_com, self.stage1_bottom_tank_moment_of_inertia_tensor, self.stage1_bottom_tank_mass),
            'stage1_top_tank': create_component(self.stage1_top_tank_com, self.stage1_top_tank_moment_of_inertia_tensor, self.stage1_top_tank_mass),
            # Interstage 1-2
            'interstage12': create_component(self.stage12_interstage_absolute_com, self.interstage12_moment_of_inertia_tensor, self.stage12_interstage_mass),
            # Stage 2
            'stage2_engine': create_component(self.stage2_engine_com, self.stage2_engine_moment_of_inertia_tensor, self.stage2_engine_mass_total),
            'stage2_bottom_propellant': create_component(self.stage2_bottom_propellant_com, self.stage2_bottom_propellant_moment_of_inertia_tensor, self.stage2_bottom_propellant_mass),
            'stage2_top_propellant': create_component(self.stage2_top_propellant_com, self.stage2_top_propellant_moment_of_inertia_tensor, self.stage2_top_propellant_mass),
            'stage2_bottom_tank': create_component(self.stage2_bottom_tank_com, self.stage2_bottom_tank_moment_of_inertia_tensor, self.stage2_bottom_tank_mass),
            'stage2_top_tank': create_component(self.stage2_top_tank_com, self.stage2_top_tank_moment_of_inertia_tensor, self.stage2_top_tank_mass),
            # Interstage 2-3
            'interstage23': create_component(self.stage23_interstage_absolute_com, self.interstage23_moment_of_inertia_tensor, self.stage23_interstage_mass),
            # Stage 3
            'stage3_engine': create_component(self.stage3_engine_com, self.stage3_engine_moment_of_inertia_tensor, self.stage3_engine_mass_total),
            'stage3_bottom_propellant': create_component(self.stage3_bottom_propellant_com, self.stage3_bottom_propellant_moment_of_inertia_tensor, self.stage3_bottom_propellant_mass),
            'stage3_top_propellant': create_component(self.stage3_top_propellant_com, self.stage3_top_propellant_moment_of_inertia_tensor, self.stage3_top_propellant_mass),
            'stage3_bottom_tank': create_component(self.stage3_bottom_tank_com, self.stage3_bottom_tank_moment_of_inertia_tensor, self.stage3_bottom_tank_mass),
            'stage3_top_tank': create_component(self.stage3_top_tank_com, self.stage3_top_tank_moment_of_inertia_tensor, self.stage3_top_tank_mass),
            # Fairing and payload
            'fairing': create_component(self.fairing_absolute_com, self.fairing_moment_of_inertia_tensor, self.fairing_mass),
            'payload': create_component(self.payload_absolute_com, self.payload_moment_of_inertia_tensor, self.payload_mass),
        }

        def calculate_shifted_for_config(reference_com, component_list):
            return {name: calculate_shifted_moment_of_inertia(components[name]['tensor'], 
                                                            components[name]['mass'], 
                                                            abs(components[name]['com'] - reference_com))
                    for name in component_list}

        # Define component lists for each configuration
        all_components = list(components.keys())
        # Interstage 1-2 phase: Stage 1 and interstage 1-2 have been jettisoned
        components_from_interstage12 = [k for k in all_components if not k.startswith('stage1_') and k != 'interstage12']
        # Stage 2 phase: Stage 1 and interstage 1-2 already gone, stage 2 and interstage 2-3 still attached
        components_from_stage2 = [k for k in all_components if not k.startswith('stage1_') and k != 'interstage12']
        # Interstage 2-3 phase: Stage 2 and interstage 2-3 have been jettisoned  
        components_from_interstage23 = [k for k in all_components if not k.startswith('stage1_') and not k.startswith('stage2_') and k != 'interstage12' and k != 'interstage23']
        # Stage 3 phase: Only stage 3, fairing, and payload remain
        components_from_stage3 = [k for k in all_components if not k.startswith('stage1_') and not k.startswith('stage2_') and k != 'interstage12' and k != 'interstage23']

        # Calculate shifted tensors for each configuration
        self.stage1_shifted = calculate_shifted_for_config(self.stage1_full_rocket_com, all_components)
        self.interstage12_shifted = calculate_shifted_for_config(self.interstage12_full_rocket_com, components_from_interstage12)
        self.stage2_shifted = calculate_shifted_for_config(self.stage2_full_rocket_com, components_from_stage2)
        self.interstage23_shifted = calculate_shifted_for_config(self.interstage23_full_rocket_com, components_from_interstage23)
        self.stage3_shifted = calculate_shifted_for_config(self.stage3_full_rocket_com, components_from_stage3)
        
    # ================================================================
    # SECTION 5: TOTAL MOI CALCULATIONS AND OUTPUT
    # ================================================================
    
    def _calculate_total_tensors(self):
        """Sum shifted tensors to get total MOI for each configuration"""
        verbose = False  # Set to True to see detailed output
        
        if verbose:
            print("Stage 1 com: ", self.stage1_com)
            print("\n=== STATIC STAGE 1 MOMENT OF INERTIA COMPONENTS ===")
            print("Component MOIs before shifting to rocket COM:")
            for component in ['stage1_engine', 'stage1_bottom_propellant', 'stage1_top_propellant', 'stage1_bottom_tank',
                            'stage1_top_tank', 'interstage12', 'stage2_engine', 'stage2_bottom_propellant', 
                            'stage2_top_propellant', 'stage2_bottom_tank', 'stage2_top_tank', 'interstage23', 
                            'stage3_engine', 'stage3_bottom_propellant', 'stage3_top_propellant', 'stage3_bottom_tank',
                            'stage3_top_tank', 'fairing', 'payload']:
                if component in self.stage1_shifted:
                    moi = self.stage1_shifted[component]
                    # Get component mass
                    if hasattr(self, f'{component}_mass'):
                        mass = getattr(self, f'{component}_mass')
                    elif hasattr(self, f'{component}_mass_total'):
                        mass = getattr(self, f'{component}_mass_total')
                    elif 'tank_head' in component:
                        stage_num = component.split('_')[0][-1]
                        mass = getattr(self, f'stage{stage_num}_tank_head_mass')
                    else:
                        mass = 0
                        
                    print(f"  {component}: mass={mass:.3f}kg")
                    print(f"    MOI diagonal: [{moi[0,0]:.3e}, {moi[1,1]:.3e}, {moi[2,2]:.3e}]")
        
        # Calculate total MOI tensors
        self.stage1_total_moment_of_inertia_tensor = sum(np.array(tensor) for tensor in self.stage1_shifted.values())
        
        print(f"\nTotal Static Stage 1 MOI diagonal: [{self.stage1_total_moment_of_inertia_tensor[0,0]:.3e}, {self.stage1_total_moment_of_inertia_tensor[1,1]:.3e}, {self.stage1_total_moment_of_inertia_tensor[2,2]:.3e}]")
        print("====================================================\n")
        
        self.interstage12_total_moment_of_inertia_tensor = sum(np.array(tensor) for tensor in self.interstage12_shifted.values())
        self.stage2_total_moment_of_inertia_tensor = sum(np.array(tensor) for tensor in self.stage2_shifted.values())
        self.interstage23_total_moment_of_inertia_tensor = sum(np.array(tensor) for tensor in self.interstage23_shifted.values())
        self.stage3_total_moment_of_inertia_tensor = sum(np.array(tensor) for tensor in self.stage3_shifted.values())
        
        # Individual components
        self.fairing_total_moment_of_inertia_tensor = self.fairing_moment_of_inertia_tensor
        self.payload_total_moment_of_inertia_tensor = self.payload_moment_of_inertia_tensor
        
    def print_component_lengths(self):
        """Print stage component dimensions for verification"""
        print("\n" + "="*70)
        print("STAGE COMPONENT LENGTH ANALYSIS")
        print("="*70)
        
        for stage_num in self.STAGE_NUMBERS:
            print(f"\n--- Stage {stage_num} ---")
            
            # Get component dimensions
            engine_length = getattr(self, f'stage{stage_num}_engine_length')
            bottom_propellant_length_total = getattr(self, f'stage{stage_num}_bottom_propellant_length')
            top_propellant_length_total = getattr(self, f'stage{stage_num}_top_propellant_length')
            tank_head_length = getattr(self, f'stage{stage_num}_tank_head_length')
            radius = getattr(self, f'stage{stage_num}_radius')
            tank_thickness = getattr(self, f'stage{stage_num}_tank_thickness')
            bottom_propellant_mass = getattr(self, f'stage{stage_num}_bottom_propellant_mass')
            bottom_propellant_density = getattr(self, f'stage{stage_num}_bottom_propellant_density')
            
            # Calculate cylinder lengths
            if stage_num == 3:
                bottom_propellant_cylinder_length = 0
                top_propellant_cylinder_length = 0
                print(f"Stage 3 uses spheres for propellant storage")
            else:
                # For bottom propellant: account for hemisphere + cylinder + annular region
                propellant_radius = radius - tank_thickness
                
                # Bottom propellant geometry
                hemisphere_volume = (2/3) * math.pi * propellant_radius**3
                hemisphere_mass = hemisphere_volume * bottom_propellant_density
                
                # Annular region mass
                annular_cylinder_vol = math.pi * propellant_radius**3
                inverted_hemisphere_vol = (2/3) * math.pi * radius**3
                annular_vol_max = annular_cylinder_vol - inverted_hemisphere_vol
                annular_mass_max = annular_vol_max * bottom_propellant_density
                
                # Middle cylinder mass and length
                cylinder_mass = bottom_propellant_mass - hemisphere_mass - annular_mass_max
                if cylinder_mass > 0:
                    cylinder_volume = cylinder_mass / bottom_propellant_density
                    bottom_propellant_cylinder_length = cylinder_volume / (math.pi * propellant_radius**2)
                else:
                    bottom_propellant_cylinder_length = 0
                
                # Top propellant has 2 hemispheres + cylinder
                top_propellant_cylinder_length = top_propellant_length_total - 2 * propellant_radius
            
            # Print dimensions
            print(f"\nStage {stage_num} Tank Geometry:")
            print(f"Total bottom propellant tank length: {bottom_propellant_length_total:.3f} m")
            if stage_num != 3:
                print(f"  - Bottom hemisphere: {radius:.3f} m")
                print(f"  - Cylinder: {bottom_propellant_cylinder_length:.3f} m")
                print(f"  - Top section (around inverted bulkhead): {radius:.3f} m")
            print(f"Total top propellant tank length: {top_propellant_length_total:.3f} m")
            if stage_num != 3:
                print(f"  - Bottom hemisphere: {propellant_radius:.3f} m")
                print(f"  - Cylinder: {top_propellant_cylinder_length:.3f} m")
                print(f"  - Top hemisphere: {propellant_radius:.3f} m")
            print(f"Tank head length (each): {tank_head_length:.3f} m")
            print(f"Number of tank heads: 3")
            
            # Total stage length
            print(f"\nStage {stage_num} Total Length Calculation:")
            print(f"  = 3 × {tank_head_length:.3f} + {top_propellant_length_total:.3f} + {bottom_propellant_length_total:.3f} + {engine_length:.3f}")
            print(f"  = {2 * tank_head_length:.3f} + {top_propellant_length_total:.3f} + {bottom_propellant_length_total:.3f} + {engine_length:.3f}")
            print(f"  = {getattr(self, f'stage{stage_num}_calculated_length'):.3f} m")
        
        # Print component tensors
        print("\n" + "="*70)
        print("COMPONENT MOMENT OF INERTIA TENSORS")
        print("="*70)
        
        print("\n--- Stage 1 Configuration (Full Rocket) ---")
        print(f"Reference COM: {self.stage1_full_rocket_com:.3f} m")
        
        all_components = [
            'stage1_engine', 'stage1_bottom_propellant', 'stage1_top_propellant', 'stage1_bottom_tank', 
            'stage1_top_tank', 'interstage12', 'stage2_engine', 'stage2_bottom_propellant', 
            'stage2_top_propellant', 'stage2_bottom_tank', 'stage2_top_tank', 'interstage23', 
            'stage3_engine', 'stage3_bottom_propellant', 'stage3_top_propellant', 'stage3_bottom_tank',
            'stage3_top_tank', 'fairing', 'payload'
        ]
        
        for component in all_components:
            # Get component mass
            if hasattr(self, f'{component}_mass'):
                mass = getattr(self, f'{component}_mass')
            elif hasattr(self, f'{component}_mass_total'):
                mass = getattr(self, f'{component}_mass_total')
            elif 'tank_head' in component:
                stage_num = component.split('_')[0][-1]
                mass = getattr(self, f'stage{stage_num}_tank_head_mass')
            else:
                continue
                
            # Get COM
            com = getattr(self, f'{component}_com') if hasattr(self, f'{component}_com') else 0
            
            # Get original tensor
            if hasattr(self, f'{component}_moment_of_inertia_tensor'):
                tensor = getattr(self, f'{component}_moment_of_inertia_tensor')
                print(f"\n{component}:")
                print(f"  Mass: {mass:.3f} kg")
                print(f"  COM: {com:.3f} m")
                print(f"  Distance from reference: {abs(com - self.stage1_full_rocket_com):.3f} m")
                print(f"  Original tensor diagonal: [{tensor[0,0]:.3e}, {tensor[1,1]:.3e}, {tensor[2,2]:.3e}]")
                if component in self.stage1_shifted:
                    shifted_moi = self.stage1_shifted[component]
                    print(f"  Shifted tensor diagonal: [{shifted_moi[0,0]:.3e}, {shifted_moi[1,1]:.3e}, {shifted_moi[2,2]:.3e}]")
        
        print("\n" + "="*70)

    # ================================================================
    # SECTION 6: DATA ACCESS AND UTILITIES
    # ================================================================
    
    def get_available_data(self):
        """
        Return a summary of all available data after initialization.
        
        This method provides a quick reference for users to understand
        what data they can access from the class instance.
        """
        return {
            "stage_properties": {
                f"stage{i}": {
                    "mass": getattr(self, f'stage{i}_total_mass'),
                    "length": getattr(self, f'stage{i}_length'),
                    "com": getattr(self, f'stage{i}_com'),
                    "propellant_order": getattr(self, f'stage{i}_propellant_order')
                } for i in self.STAGE_NUMBERS
            },
            "configurations": {
                "stage1_full_rocket": {
                    "total_mass": self.stage1_full_rocket_mass,
                    "com": self.stage1_full_rocket_com,
                    "moi_tensor": self.stage1_total_moment_of_inertia_tensor
                },
                "stage2_partial": {
                    "total_mass": self.stage2_full_rocket_mass,
                    "com": self.stage2_full_rocket_com,
                    "moi_tensor": self.stage2_total_moment_of_inertia_tensor
                },
                "stage3_partial": {
                    "total_mass": self.stage3_full_rocket_mass,
                    "com": self.stage3_full_rocket_com,
                    "moi_tensor": self.stage3_total_moment_of_inertia_tensor
                },
                "stage3_empty": {
                    "total_mass": self.stage3_empty_mass,
                    "com": self.stage3_empty_com,
                    "moi_tensor": self.stage3_empty_total_moment_of_inertia_tensor
                }
            },
            "component_data_available": [
                f"stage{i}_{comp}_mass" for i in self.STAGE_NUMBERS 
                for comp in ['engine', 'bottom_propellant', 'top_propellant', 'bottom_tank', 'top_tank']
            ] + ['fairing_mass', 'payload_mass']
        }
    
    def print_summary(self):
        """Print a human-readable summary of the rocket configuration"""
        print("\n" + "="*70)
        print("ROCKET STATIC CONFIGURATION SUMMARY")
        print("="*70)
        
        for i in self.STAGE_NUMBERS:
            print(f"\nStage {i}:")
            print(f"  Total Mass: {getattr(self, f'stage{i}_total_mass'):.1f} kg")
            print(f"  Length: {getattr(self, f'stage{i}_length'):.3f} m")
            print(f"  Propellant Order: {getattr(self, f'stage{i}_propellant_order')}")
            print(f"  Bottom Propellant Mass: {getattr(self, f'stage{i}_bottom_propellant_mass'):.1f} kg")
            print(f"  Top Propellant Mass: {getattr(self, f'stage{i}_top_propellant_mass'):.1f} kg")
        
        print("\nPayload Mass:", f"{self.payload_mass:.1f} kg")
        print("Fairing Mass:", f"{self.fairing_mass:.1f} kg")
        
        print("\nFull Rocket Configurations:")
        print(f"  Stage 1 (Full): {self.stage1_full_rocket_mass:.1f} kg, COM: {self.stage1_full_rocket_com:.3f} m")
        print(f"  Stage 2 (w/o S1): {self.stage2_full_rocket_mass:.1f} kg, COM: {self.stage2_full_rocket_com:.3f} m")
        print(f"  Stage 3 (w/o S1&2): {self.stage3_full_rocket_mass:.1f} kg, COM: {self.stage3_full_rocket_com:.3f} m")
        print("="*70)

    