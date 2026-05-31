import numpy as np
from .moment_of_inertia_functions import calculate_current_fuel_and_ox_masses_and_lengths_stages12
from .moment_of_inertia_functions import calculate_current_fuel_and_ox_masses_and_lengths_stage3
from .moment_of_inertia_functions import calculate_shifted_moment_of_inertia
from .moment_of_inertia_functions import create_component
from .moment_of_inertia_functions import calculate_dynamic_bottom_propellant_moment_of_inertia_s12
from .moment_of_inertia_functions import calculate_dynamic_top_propellant_moment_of_inertia_s12
from .moment_of_inertia_functions import calculate_hemisphere_moment_of_inertia
from .moment_of_inertia_functions import calculate_stage3_propellant_moment_of_inertia


############################################################
# TODO: 
# ----------------------------------------------------------
# tank heads are still spherical, not elliptical
# add checks for stage 3 spherical tank fullness
# add empty tankparts in partial fullness to the calculation / check if base is correct
# split intial propellant length into intial propellant length and tank length
############################################################


class DynamicMomentOfInertia:
    """
    Calculate dynamic moment of inertia during rocket flight.
    
    This class handles real-time MOI calculations as propellant is consumed during flight.
    It works in conjunction with the StaticMomentOfInertia class which provides baseline values.
    
    CALCULATION FLOW:
    1. FLIGHT PHASE DETECTION: Determine active stage from enables array
    2. PROPELLANT DISTRIBUTION: Calculate current propellant masses and geometry
    3. COMPONENT COM: Calculate center of mass for dynamic propellants
    4. STAGE ASSEMBLY: Combine all components of active stage
    5. ROCKET ASSEMBLY: Combine all stages, interstages, payload, and fairing
    6. MOI CALCULATION: Calculate MOI tensors for all components
    7. REFERENCE SHIFT: Apply parallel axis theorem to common reference
    8. TOTAL MOI: Sum all component tensors
    
    The class handles different flight phases:
    - Freefall: Uses static values (no propellant consumption)
    - Stage burning: Dynamic calculation with changing propellant
    - Interstage phases: Uses static values for coasting periods
    """
    
    def __init__(self, static_moi):
        """
        Initialize with static MOI data.
        
        Args:
            static_moi: StaticMomentOfInertia instance containing baseline values
        """
        self.static = static_moi
        
        # Store last calculation data for debugging
        self._last_active_phase = None
        self._last_propellant_data = None
        self._last_rocket_com = None
        self._last_total_mass = None
        
    # ================================================================
    # SECTION 1: MAIN CALCULATION ENTRY POINT
    # ================================================================
    
    def calculate(self, enables, current_propellant_mass, current_height):
        """
        Main entry point for dynamic MOI calculation.
        
        Args:
            enables: Array indicating active flight phase 
                    [freefall, stage1, interstage12, stage2, interstage23, stage3]
            current_propellant_mass: Current propellant mass in active stage (kg)
            current_height: Current altitude for fairing jettison logic (m)
        
        Returns:
            tuple: (center_of_mass, moment_of_inertia_tensor)
        """
        # Determine fairing presence (jettisoned above 120km)
        # fairing_mass = self.static.fairing_mass if current_height <= 120000 else 0
        fairing_mass = self.static.fairing_mass if current_height <= 120000 else 0

        # Route to appropriate calculation based on flight phase
        if enables[0] == 1:  # Freefall
            self._last_active_phase = 'freefall'
            return self.static.stage1_full_rocket_com, self.static.stage1_total_moment_of_inertia_tensor
        elif enables[1] == 1:  # Stage 1
            self._last_active_phase = 'stage1'
            return self._calculate_dynamic_stage(1, current_propellant_mass, fairing_mass)
        elif enables[2] == 1:  # Interstage 1-2
            self._last_active_phase = 'interstage12'
            return self.static.interstage12_full_rocket_com, self.static.interstage12_total_moment_of_inertia_tensor
        elif enables[3] == 1:  # Stage 2
            self._last_active_phase = 'stage2'
            return self._calculate_dynamic_stage(2, current_propellant_mass, fairing_mass)
        elif enables[4] == 1:  # Interstage 2-3
            self._last_active_phase = 'interstage23'
            return self.static.interstage23_full_rocket_com, self.static.interstage23_total_moment_of_inertia_tensor
        else:  # Stage 3 or other phases
            self._last_active_phase = 'stage3'
            return self._calculate_dynamic_stage(3, current_propellant_mass, fairing_mass)
    
    def _calculate_dynamic_stage(self, stage_num, current_propellant_mass, fairing_mass):
        """
        Calculate dynamic properties for a burning stage.
        
        Args:
            stage_num: The number of the burning stage (1, 2, or 3)
            current_propellant_mass: Current propellant mass in the burning stage (kg)
            fairing_mass: Mass of the fairing (0 if jettisoned, otherwise static fairing mass)
        
        Returns:
            tuple: (center_of_mass, moment_of_inertia_tensor)
        """
        # Calculate current propellant properties including COMs from top
        current_bottom_propellant_mass, current_top_propellant_mass, bottom_propellant_length, top_propellant_length, bottom_propellant_com_from_top, top_propellant_com_from_top = \
            self._calculate_propellant_properties(current_propellant_mass, stage_num)
        
        # Store propellant data for debugging
        self._last_propellant_data = {
            'total_mass': current_propellant_mass,
            'bottom_mass': current_bottom_propellant_mass,
            'top_mass': current_top_propellant_mass,
            'bottom_length': bottom_propellant_length,
            'top_length': top_propellant_length
        }
        
        # Calculate absolute COMs
        stage_offset = self._calculate_stage_offset(stage_num)
        bottom_propellant_com, top_propellant_com = self._calculate_component_com(bottom_propellant_com_from_top, top_propellant_com_from_top, stage_offset)
        
        # Calculate stage COM and mass
        stage_mass, stage_com = self._calculate_stage_com(stage_num, current_bottom_propellant_mass, current_top_propellant_mass, bottom_propellant_com, top_propellant_com)
        
        # Collect all rocket components
        rocket_components = self._collect_rocket_components(stage_mass, stage_com, stage_num, fairing_mass)
        
        # Calculate full rocket properties
        full_mass, full_com = self._calculate_full_rocket_properties(rocket_components)
        
        # Store for debugging
        self._last_rocket_com = full_com
        self._last_total_mass = full_mass
        
        # Create components dictionary and calculate MOI
        components = self._create_dynamic_components_dict(
            stage_num, current_bottom_propellant_mass, current_top_propellant_mass, bottom_propellant_com, top_propellant_com, 
            bottom_propellant_length, top_propellant_length, rocket_components, full_com
        )
        
        total_moi = self._calculate_total_moment_of_inertia(components, full_com)
        
        return full_com, total_moi
    
    # ================================================================
    # SECTION 2: PROPELLANT DISTRIBUTION CALCULATIONS
    # ================================================================
    
    def _calculate_propellant_properties(self, current_propellant_mass, stage_num):
        """
        Calculate current propellant distribution based on consumption.
        
        This determines:
        - How much propellant remains in each tank
        - The physical length/volume occupied by remaining propellant
        - The center of mass of propellant in each tank
        
        Args:
            current_propellant_mass: Total remaining propellant mass
            stage_num: Stage number (1, 2, or 3)
            
        Returns:
            tuple: (bottom_mass, top_mass, bottom_length, top_length, 
                   bottom_com_from_top, top_com_from_top)
        """
        if stage_num == 3:
            # Use stage 3 specific function for spherical tanks
            # Get original fuel and ox data (before propellant_order mapping)
            stage_data = getattr(self.static, f'stage{stage_num}')
            fuel_mass = stage_data['Fuel. Mass [kg]']
            ox_mass = stage_data['Ox. Mass [kg]']
            fuel_volume = fuel_mass / stage_data['Fuel. Density [kg/m^3]']
            ox_volume = stage_data['Ox. Volume [m^3]']
            
            # Get initial lengths based on propellant order
            propellant_order = getattr(self.static, f'stage{stage_num}_propellant_order')
            if propellant_order == 'fuel_first':
                fuel_length_initial = getattr(self.static, f'stage{stage_num}_bottom_propellant_length')
                ox_length_initial = getattr(self.static, f'stage{stage_num}_top_propellant_length')
            else:
                fuel_length_initial = getattr(self.static, f'stage{stage_num}_top_propellant_length')
                ox_length_initial = getattr(self.static, f'stage{stage_num}_bottom_propellant_length')
            
            return calculate_current_fuel_and_ox_masses_and_lengths_stage3(
                                                current_propellant_mass,
                                                getattr(self.static, f'stage{stage_num}_of_ratio'),
                                                fuel_mass,
                                                fuel_volume,
                                                ox_mass,
                                                ox_volume,
                                                getattr(self.static, f'stage{stage_num}_radius'),
                                                getattr(self.static, f'stage{stage_num}_tank_thickness'),
                                                fuel_length_initial,
                                                ox_length_initial,
                                                getattr(self.static, f'stage{stage_num}_tank_head_length'),
                                                propellant_order
                                                )
        else:
            # Use stages 1&2 function for cylindrical tanks
            # Get original fuel and ox data (before propellant_order mapping)
            stage_data = getattr(self.static, f'stage{stage_num}')
            fuel_mass = stage_data['Fuel. Mass [kg]']
            ox_mass = stage_data['Ox. Mass [kg]']
            fuel_volume = fuel_mass / stage_data['Fuel. Density [kg/m^3]']
            ox_volume = stage_data['Ox. Volume [m^3]']
            
            # Get initial lengths based on propellant order
            propellant_order = getattr(self.static, f'stage{stage_num}_propellant_order')
            if propellant_order == 'fuel_first':
                fuel_length_initial = getattr(self.static, f'stage{stage_num}_bottom_propellant_length')
                ox_length_initial = getattr(self.static, f'stage{stage_num}_top_propellant_length')
            else:
                fuel_length_initial = getattr(self.static, f'stage{stage_num}_top_propellant_length')
                ox_length_initial = getattr(self.static, f'stage{stage_num}_bottom_propellant_length')
            
            return calculate_current_fuel_and_ox_masses_and_lengths_stages12(
                                                current_propellant_mass,
                                                getattr(self.static, f'stage{stage_num}_of_ratio'),
                                                fuel_mass,
                                                fuel_volume,
                                                ox_mass,
                                                ox_volume,
                                                getattr(self.static, f'stage{stage_num}_radius'),
                                                getattr(self.static, f'stage{stage_num}_tank_thickness'),
                                                fuel_length_initial,
                                                ox_length_initial,
                                                getattr(self.static, f'stage{stage_num}_tank_head_length'),
                                                propellant_order
                                                )
    
    # ================================================================
    # SECTION 3: CENTER OF MASS CALCULATIONS
    # ================================================================
    
    def _calculate_stage_offset(self, stage_num):
        """
        Calculate the offset from rocket top to stage top.
        
        This is needed because component COMs are calculated relative to 
        their stage top, but we need absolute positions from rocket top.
        """
        if stage_num == 1:
            return self.static.payload_length + self.static.stage3_length + self.static.stage2_length
        elif stage_num == 2:
            return self.static.payload_length + self.static.stage3_length
        elif stage_num == 3:
            return self.static.payload_length
        return 0
    
    def _calculate_component_com(self, bottom_propellant_com_from_top, top_propellant_com_from_top, stage_offset):
        """Convert component COMs from stage-relative to rocket-absolute positions."""
        return stage_offset + bottom_propellant_com_from_top, stage_offset + top_propellant_com_from_top
    
    def _calculate_stage_com(self, stage_num, current_bottom_propellant_mass, current_top_propellant_mass, 
                           bottom_propellant_com, top_propellant_com):
        """
        Calculate the center of mass for the complete stage assembly.
        
        Combines:
        - Engine
        - Bottom propellant (dynamic)
        - Top propellant (dynamic)
        - Bottom tank structure
        - Top tank structure
        """
        # Collect component masses and COMs
        components = {
            'engine': (getattr(self.static, f'stage{stage_num}_engine_mass_total'), 
                        getattr(self.static, f'stage{stage_num}_engine_com')),
            'bottom_propellant': (current_bottom_propellant_mass, bottom_propellant_com),
            'top_propellant': (current_top_propellant_mass, top_propellant_com),
            'bottom_tank': (getattr(self.static, f'stage{stage_num}_bottom_tank_mass'),
                            getattr(self.static, f'stage{stage_num}_bottom_tank_com')),
            'top_tank': (getattr(self.static, f'stage{stage_num}_top_tank_mass'),
                        getattr(self.static, f'stage{stage_num}_top_tank_com'))
        }
        
        # Calculate total mass and weighted COM
        total_mass = sum(mass for mass, _ in components.values())
        weighted_com = sum(mass * com for mass, com in components.values())
        stage_com = weighted_com / total_mass
        
        return total_mass, stage_com
    
    # ================================================================
    # SECTION 4: ROCKET ASSEMBLY AND CONFIGURATION
    # ================================================================
    
    def _collect_rocket_components(self, active_stage_mass, active_stage_com, stage_num, fairing_mass):
        """
        Collect all components of the rocket based on active stage.
        
        The rocket configuration changes as stages are jettisoned:
        - Stage 1 active: All stages + interstages + fairing + payload
        - Stage 2 active: Stages 2&3 + interstage 2-3 + fairing + payload
        - Stage 3 active: Stage 3 + fairing + payload
        """
        components = {
            f'stage{stage_num}': (active_stage_mass, active_stage_com),
            'fairing': (fairing_mass, self.static.fairing_absolute_com),
            'payload': (self.static.payload_mass, self.static.payload_absolute_com)
        }
        
        # Add components based on which stage is active
        if stage_num == 1:
            components.update({
                'interstage12': (self.static.stage12_interstage_mass, self.static.stage12_interstage_absolute_com),
                'stage2': (self.static.stage2_total_mass, self.static.stage2_absolute_com),
                'interstage23': (self.static.stage23_interstage_mass, self.static.stage23_interstage_absolute_com),
                'stage3': (self.static.stage3_total_mass, self.static.stage3_absolute_com)
            })
        elif stage_num == 2:
            components.update({
                'interstage23': (self.static.stage23_interstage_mass, self.static.stage23_interstage_absolute_com),
                'stage3': (self.static.stage3_total_mass, self.static.stage3_absolute_com)
            })
        # Stage 3 only has fairing and payload (already added)
        
        return components
    
    def _calculate_full_rocket_properties(self, rocket_components):
        """
        Calculate full rocket mass and center of mass
        
        Returns:
            tuple: (total_mass, center_of_mass)
        """
        total_mass = sum(mass for mass, _ in rocket_components.values())
        weighted_com = sum(mass * com for mass, com in rocket_components.values())
        
        return total_mass, weighted_com / total_mass
    
    # ================================================================
    # SECTION 5: MOMENT OF INERTIA CALCULATIONS
    # ================================================================
    
    def _create_dynamic_components_dict(self, stage_num, current_bottom_propellant_mass, current_top_propellant_mass, 
                                       bottom_propellant_com, top_propellant_com, bottom_propellant_length, top_propellant_length, 
                                       rocket_components, full_rocket_com):
        """
        Create comprehensive component dictionary with MOI tensors.
        
        This method:
        1. Calculates dynamic MOI for changing propellant volumes
        2. Retrieves static MOI for structural components
        3. Organizes all components for parallel axis theorem application
        """
        # Dynamic propellant moment of inertia tensors using geometry-specific functions
        if stage_num in [1, 2]:
            # Stages 1&2: Use new geometry calculations
            bottom_propellant_moi = calculate_dynamic_bottom_propellant_moment_of_inertia_s12(
                current_bottom_propellant_mass,
                bottom_propellant_length,
                getattr(self.static, f'stage{stage_num}_radius'),
                getattr(self.static, f'stage{stage_num}_tank_thickness'),
                getattr(self.static, f'stage{stage_num}_bottom_propellant_density'),
                getattr(self.static, f'stage{stage_num}_bottom_propellant_length')
            )
            top_propellant_moi = calculate_dynamic_top_propellant_moment_of_inertia_s12(
                current_top_propellant_mass, 
                top_propellant_length,
                getattr(self.static, f'stage{stage_num}_radius'),
                getattr(self.static, f'stage{stage_num}_tank_thickness'),
                getattr(self.static, f'stage{stage_num}_top_propellant_density'),
                getattr(self.static, f'stage{stage_num}_top_propellant_length')
            )
        elif stage_num == 3:
            # Stage 3: Use unified spherical tank function
            # Calculate propellant volumes from mass and density
            bottom_propellant_volume = current_bottom_propellant_mass / getattr(self.static, f'stage{stage_num}_bottom_propellant_density')
            top_propellant_volume = current_top_propellant_mass / getattr(self.static, f'stage{stage_num}_top_propellant_density')
            
            bottom_propellant_moi = calculate_stage3_propellant_moment_of_inertia(
                propellant_mass=current_bottom_propellant_mass,
                propellant_volume=bottom_propellant_volume,
                tank_radius=getattr(self.static, f'stage{stage_num}_radius'),
                tank_thickness=getattr(self.static, f'stage{stage_num}_tank_thickness'),
                propellant_density=getattr(self.static, f'stage{stage_num}_bottom_propellant_density'),
                is_bottom_propellant=True
            )
            top_propellant_moi = calculate_stage3_propellant_moment_of_inertia(
                propellant_mass=current_top_propellant_mass,
                propellant_volume=top_propellant_volume,
                tank_radius=getattr(self.static, f'stage{stage_num}_radius'),
                tank_thickness=getattr(self.static, f'stage{stage_num}_tank_thickness'),
                propellant_density=getattr(self.static, f'stage{stage_num}_top_propellant_density'),
                is_bottom_propellant=False
            )
        
        # Build components dictionary with static and dynamic components
        components = {}
        
        # Add dynamic stage components
        components[f'stage{stage_num}_bottom_propellant'] = create_component(bottom_propellant_com, bottom_propellant_moi, current_bottom_propellant_mass)
        components[f'stage{stage_num}_top_propellant'] = create_component(top_propellant_com, top_propellant_moi, current_top_propellant_mass)
        
        # Add static stage components
        for comp in ['engine', 'bottom_tank', 'top_tank']:
            comp_name = f'stage{stage_num}_{comp}'
            if comp == 'engine':
                mass_attr = f'{comp_name}_mass_total'
            else:
                mass_attr = f'{comp_name}_mass'
            
            components[comp_name] = create_component(
                getattr(self.static, f'{comp_name}_com'),
                getattr(self.static, f'{comp_name}_moment_of_inertia_tensor'),
                getattr(self.static, mass_attr)
            )
        
        # Add other rocket components (stages, interstages, fairing, payload)
        for name, (mass, com) in rocket_components.items():
            if name != f'stage{stage_num}':  # Skip only the exact active stage (already added in pieces)
                if name.startswith('stage') and not name.startswith('interstage'):
                    # Other stages (but not interstages)
                    stage_n = name[-1]
                    components.update(self._get_static_stage_components(int(stage_n)))
                elif 'interstage' in name:
                    # Interstages
                    components[name] = create_component(
                        com,
                        getattr(self.static, f'{name}_moment_of_inertia_tensor'),
                        mass
                    )
                else:
                    # Fairing and payload
                    components[name] = create_component(
                        com,
                        getattr(self.static, f'{name}_moment_of_inertia_tensor'),
                        mass
                    )
        
        return components
    
    def _get_static_stage_components(self, stage_num):
        """Get all static components for a non-active stage"""
        components = {}
        for comp in ['engine', 'bottom_propellant', 'top_propellant', 'bottom_tank', 'top_tank']:
            comp_name = f'stage{stage_num}_{comp}'
            # Determine the correct mass attribute
            if comp == 'engine':
                mass_attr = f'{comp_name}_mass_total'
            else:
                mass_attr = f'{comp_name}_mass'
                
            components[comp_name] = create_component(
                getattr(self.static, f'{comp_name}_com'),
                getattr(self.static, f'{comp_name}_moment_of_inertia_tensor'),
                getattr(self.static, mass_attr)
            )
        return components
    
    # ================================================================
    # SECTION 6: REFERENCE FRAME TRANSFORMATIONS
    # ================================================================
    
    def _calculate_total_moment_of_inertia(self, components, reference_com):
        """
        Apply parallel axis theorem and sum all component MOIs.
        
        This shifts all component MOI tensors from their local reference
        frames to the common rocket center of mass reference frame.
        """
        return sum(
            np.array(calculate_shifted_moment_of_inertia(
                comp['tensor'],
                comp['mass'],
                abs(comp['com'] - reference_com)
            ))
            for comp in components.values()
        )
    
    # ================================================================
    # SECTION 7: UTILITY METHODS AND DEBUGGING
    # ================================================================
    
    def get_calculation_summary(self):
        """
        Return summary of last calculation for debugging.
        
        Useful for verifying:
        - Which phase was active
        - Propellant distribution
        - Final COM position
        - Total rocket mass
        """
        return {
            'active_phase': self._last_active_phase,
            'propellant_data': self._last_propellant_data,
            'rocket_com': self._last_rocket_com,
            'total_mass': self._last_total_mass
        }