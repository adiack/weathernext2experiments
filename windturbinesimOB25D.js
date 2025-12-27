/**
 * ============================================================================
 * WIND TURBINE GRID SIMULATOR (Experimental, based on forecast data)
 * ============================================================================
 * * Description:
 * * A preliminary "prospecting" tool to estimate theoretical wind potential 
 * versus local building density.
 * * This simulation uses "Equivalent Households" as its unit.
 * * It treats every detected building footprint as a single residential unit.
 * * Large consumers (e.g Airports, Factories) are NOT weighted for higher consumption.
 * *
 * * Key Features:
 * - Fetches real-time weather model data (WeatherNext-2).
 * - Calculates daily power generation using physics-based wind formulas.
 * - Visualizes ONLY "Powered" houses using a probabilistic lottery system.
 * - This script is just for fun don't take it too seriously 
 * * Updated: Dec 2025
 * * License: MIT 
 */

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================

var CONFIG = {
  // Physics & Engineering Constants
  PHYSICS: {
    ROTOR_DIAMETER_M: 120,      // Industrial scale turbine (Swept Area determines power capture)
    SYSTEM_EFFICIENCY: 0.40,    // 'Cp' Coefficient of Power. Betz limit is 0.59; 0.40 is realistic.
    AIR_DENSITY: 1.225,         // 'rho' in kg/m³ (Standard sea level air density)
    MIN_WPD_THRESHOLD: 200,     // W/m² required for viable generation
    MAX_GENERATION_KW: 3000     // Nameplate capacity cap (3MW Turbine)
  },

  // Geospatial Data Filters
  DATA: {
    BUILDING_COLLECTION: 'GOOGLE/Research/open-buildings-temporal/v1',
    WEATHER_COLLECTION: 'projects/gcp-public-data-weathernext/assets/weathernext_2_0_0',
    CONFIDENCE_THRESHOLD: 0.7,  // Minimum confidence for building detection
    MIN_HEIGHT_M: 1.5           // Ignore tiny structures
  },

  // UI Defaults & Style
  UI: {
    START_LAT: 2.0306,          // Mogadishu
    START_LON: 45.3409,
    START_ZOOM: 14,
    TURBINE_COLOR: '00FFFF',    // Cyan
    TURBINE_SIZE: 15,
    POWERED_COLOR: '0000FF',    // Blue
    PANEL_WIDTH: '450px'
  },

  // Preset Locations for the Dropdown
  LOCATIONS: {
    'Mogadishu, Somalia': [45.3409, 2.0306],
    'Nouakchott, Mauritania': [-15.9585, 18.0735],
    'Cape Town, South Africa': [18.4619, -33.9135],
    'Paraguana, Venezuela': [-69.9431, 11.7583],
    'Barranquilla, Colombia': [-74.7813, 10.9685]
  }
};

// ============================================================================
// 2. GLOBAL STATE MANAGEMENT
// ============================================================================

/**
 * APP_STATE holds the transient data for the currently selected location.
 * We use a global object to avoid passing 7+ arguments to every UI update function.
 */
var APP_STATE = {
  wpd: 0,               // Mean Wind Power Density (W/m²)
  kwhPerTurbine: 0,     // Average Daily kWh output per turbine
  buildings: 0,         // Total count of valid buildings in radius
  hasData: false,       // Flag to prevent rendering empty states
  timeSeriesData: null, // FeatureCollection of daily wind stats (for charting)
  buildingRaster: null, // Pre-computed binary image of buildings (1=building)
  centerPoint: null     // ee.Geometry.Point of the click
};

print('System Initialized: UI rendering...');

// ============================================================================
// 3. DATA PRE-PROCESSING
// ============================================================================

// WeatherNext Collection Filter
// We filter for a specific ensemble member and forecast hour to get a consistent time series.
var rawCollection = ee.ImageCollection(CONFIG.DATA.WEATHER_COLLECTION)
    .filter(ee.Filter.eq('ensemble_member', '8'))
    .filter(ee.Filter.eq('forecast_hour', 6));

// Fail-Safe Date Retrieval
// In rare cases, 'first()' can return null if the collection is updating.
// We use ee.Algorithms.If to provide a hard fallback to prevent crash.
var latestImage = rawCollection.sort('system:time_start', false).first();
var safeDate = ee.Algorithms.If(
  latestImage, 
  ee.Date(latestImage.get('system:time_start')), 
  ee.Date('2024-01-01') // Fallback date
);
var endDate = ee.Date(safeDate);
var startDate = endDate.advance(-1, 'year');
var weatherSeries = rawCollection.filterDate(startDate, endDate);


// ============================================================================
// 4. UI COMPONENT CONSTRUCTION
// ============================================================================

// Main container panel
var mainPanel = ui.Panel({
  style: {
    position: 'bottom-right', 
    width: CONFIG.UI.PANEL_WIDTH, 
    maxHeight: '900px', 
    padding: '10px',
    backgroundColor: 'rgba(255, 255, 255, 0.95)'
  }
});

// -- Header Components --
var title = ui.Label('Wind Turbine Power Evaluator (Experimental)', {fontWeight: 'bold', fontSize: '15px', color: '#003366'});
var desc = ui.Label('Visual Grid Coverage Simulator', {fontSize: '10px', color: 'gray'});

// -- Navigation --
var locLabel = ui.Label('Jump to High Potential Site:', {fontWeight: 'bold', margin: '10px 0 5px 0'});
var locSelect = ui.Select({
  items: Object.keys(CONFIG.LOCATIONS),
  placeholder: 'Select a location...',
  onChange: function(key) {
    if (key && CONFIG.LOCATIONS[key]) {
      var coords = CONFIG.LOCATIONS[key];
      Map.setCenter(coords[0], coords[1], CONFIG.UI.START_ZOOM);
    }
  }
});

// -- Parameter Controls --
var turbLabel = ui.Label('Project Scale: # of Turbine', {fontWeight: 'bold', margin: '15px 0 5px 0'});
var turbSlider = ui.Slider({min: 1, max: 10, value: 1, step: 1, style: {width: '380px'}});

var loadLabel = ui.Label('Avg Home Load: 1.5 kWh/day (Tier 3)', {fontWeight: 'bold', margin: '15px 0 5px 0'});
var loadSlider = ui.Slider({min: 0.5, max: 30, value: 1.5, step: 0.5, style: {width: '380px'}});

// -- Dynamic Panels --
var statsPanel = ui.Panel({style: {padding: '8px', margin: '10px 0', border: '1px solid #ddd', borderRadius: '4px'}});
var chartPanel = ui.Panel({style: {margin: '10px 0'}}); 
var methodPanel = ui.Panel({style: {padding: '8px', margin: '10px 0', backgroundColor: '#f9f9f9', fontSize: '10px'}});

// -- Assembly --
mainPanel.add(title);
//mainPanel.add(desc);
mainPanel.add(locLabel);
mainPanel.add(locSelect);
mainPanel.add(turbLabel);
mainPanel.add(turbSlider);
mainPanel.add(loadLabel);
mainPanel.add(loadSlider);
mainPanel.add(statsPanel);
mainPanel.add(chartPanel);
mainPanel.add(methodPanel);

// -- Static Documentation --
//methodPanel.add(ui.Label('Legend:', {fontWeight: 'bold', fontSize: '12px'}));
methodPanel.add(ui.Label('• Cyan Dot: Turbine Location'));
methodPanel.add(ui.Label('• Blue Houses: Powered '));
//methodPanel.add(ui.Label('Calculation Formula:', {fontWeight: 'bold', fontSize: '12px', margin: '10px 0 0 0'}));
methodPanel.add(ui.Label('Power = 0.5 × Air Density × Area × Velocity³', {fontSize: '11px', color: '#555'}));


// ============================================================================
// 5. EVENT HANDLERS & LOGIC
// ============================================================================

/**
 * Handles slider changes. Updates UI text and triggers the visualization refresh.
 */
var onParamsChange = function() {
  var tVal = turbSlider.getValue();
  var lVal = loadSlider.getValue();
  
  // Update Labels
  turbLabel.setValue('Project Scale: ' + tVal + ' Turbines');
  var tier = lVal < 1 ? '(Basic)' : lVal < 5 ? '(Standard Household)' : '(Heavy/Industrial)';
  loadLabel.setValue('Avg Home Load: ' + lVal + ' kWh/day ' + tier);
  
  // Refresh Visuals
  renderVisuals(); 
};

turbSlider.onChange(onParamsChange);
loadSlider.onChange(onParamsChange);

/**
 * The Core Rendering Function.
 * It takes the current APP_STATE and the slider values to draw the map layers and charts.
 * This is separated from data fetching to ensure sliders are responsive.
 */
function renderVisuals() {
  if (!APP_STATE.hasData) return;

  var numTurbines = turbSlider.getValue();
  var consumption = loadSlider.getValue(); 
  
  // --- 1. Feasibility Calculation ---
  var totalDailyKWh = APP_STATE.kwhPerTurbine * numTurbines;
  var homesSupported = Math.floor(totalDailyKWh / consumption);
  
  var coverageRatio = 0;
  if (APP_STATE.buildings > 0) {
    coverageRatio = homesSupported / APP_STATE.buildings;
  }
  var cappedRatio = Math.min(coverageRatio, 1.0); // Clamp to 100%
  
  // --- 2. Map Visualization (The "Lottery") ---
  Map.layers().reset(); 
  
  // Turbine Marker
  Map.addLayer(APP_STATE.centerPoint, 
    {color: CONFIG.UI.TURBINE_COLOR, pointSize: CONFIG.UI.TURBINE_SIZE}, 
    'Turbine Location (Center)'
  );

  if (APP_STATE.buildingRaster) {
    // Generate static random noise.
    // CRITICAL: Reproject to EPSG:3857 at 4m scale to ensure house-level granularity.
    var seed = ee.Image.random(42).reproject({
      crs: 'EPSG:3857', 
      scale: 4 
    });
    
    // Logic: Identify pixels that win the "lottery"
    var isPowered = seed.lt(cappedRatio); 
    
    // Masking Strategy:
    // We update the mask so that ONLY pixels that are:
    // 1. Buildings (from buildingRaster)
    // 2. AND Powered (from isPowered)
    // ...are visible. Everything else is transparent.
    var finalVisual = isPowered.updateMask(
        APP_STATE.buildingRaster.select('building_presence').and(isPowered)
    );

    Map.addLayer(finalVisual, 
      {palette: [CONFIG.UI.POWERED_COLOR]}, // Only Blue
      'Powered Households'
    );
  }

  // --- 3. Stats Panel Update ---
  statsPanel.clear();
  var meanWPD = APP_STATE.wpd;
  
  // Color-coding for text
  var wpdColor = meanWPD < 200 ? 'black' : meanWPD < 400 ? 'orange' : 'green';
  var quality = meanWPD < 200 ? 'Poor' : meanWPD < 400 ? 'Good' : 'Excellent';
  
  statsPanel.add(ui.Label('Resource Quality (at 100m height):', {fontWeight: 'bold'}));
  statsPanel.add(ui.Label({
      value: Math.round(meanWPD) + ' W/m² (' + quality + ')',
      style: {fontSize: '12px', fontWeight: 'bold', color: wpdColor, margin: '4px 0'}
  }));
  
  statsPanel.add(ui.Label('Grid Feasibility:', {fontWeight: 'bold', margin: '8px 0 0 0'}));
  statsPanel.add(ui.Label('Avg Generation: ' + Math.round(totalDailyKWh).toLocaleString() + ' kWh/day'));
  
  var pctVal = coverageRatio * 100;
  var pctText = pctVal >= 100 ? '>100%' : pctVal.toFixed(1) + '%';
  
  statsPanel.add(ui.Label('Potential Coverage: ' + homesSupported.toLocaleString() + ' / ' + APP_STATE.buildings.toLocaleString() + ' homes', 
       {color: 'black', fontWeight: 'bold'}));
  
  // Status Indicator
  if (pctVal >= 100) {
      statsPanel.add(ui.Label('STATUS: FULL COVERAGE', {color: 'green', fontWeight: 'bold', margin: '5px 0'}));
  } else {
      statsPanel.add(ui.Label('STATUS: PARTIAL COVERAGE (' + pctText + ')', 
           {color: 'orange', fontWeight: 'bold', fontSize: '10px', margin: '5px 0'}));
  }

  // --- 4. Chart Updates ---
  chartPanel.clear();
  
  // Calculate dynamic "Houses Powered" based on current sliders
  var houseChartData = APP_STATE.timeSeriesData.map(function(f) {
    var dailyGen = f.getNumber('Daily_KWh_Per_Turbine');
    var totalGen = dailyGen.multiply(numTurbines);
    var houses = totalGen.divide(consumption).floor();
    return f.set('Houses_Powered', houses);
  });

  var housesChart = ui.Chart.feature.byFeature(houseChartData, 'system:time_start', ['Houses_Powered'])
    .setChartType('AreaChart')
    .setOptions({
      title: 'Daily House Coverage (1 Year)',
      vAxis: {title: 'Equivalent Households'},
      legend: {position: 'none'},
      colors: [CONFIG.UI.POWERED_COLOR],
      height: '110px',
      hAxis: {format: 'MMM'}
    });
  chartPanel.add(housesChart);

  // Add Threshold line to WPD data
  var wpdData = APP_STATE.timeSeriesData.map(function(f) {
     return f.set('Min_Required', CONFIG.PHYSICS.MIN_WPD_THRESHOLD); 
  });

  var wpdChart = ui.Chart.feature.byFeature(wpdData, 'system:time_start', ['WPD', 'Min_Required'])
    .setChartType('LineChart')
    .setOptions({
      title: 'Wind Resource Consistency', 
      vAxis: {title: 'W/m²'},
      series: {
        0: {color: '#1e90ff', lineWidth: 1}, 
        1: {color: 'red', lineWidth: 1, lineDashStyle: [4, 4], pointSize: 0}
      },
      height: '140px'
    });
  chartPanel.add(wpdChart);
}

/**
 * Handles Map Clicks.
 * 1. Resets UI.
 * 2. Fetches Weather Data (Time Series).
 * 3. Fetches Building Data (Spatial Reduction).
 * 4. Updates Global State and calls renderVisuals().
 */
Map.onClick(function(coords) {
  // UI Reset
  statsPanel.clear();
  chartPanel.clear();
  statsPanel.add(ui.Label('Scanning Site & Analyzing Buildings...(~1-2min)', {color: 'orange'}));
  Map.layers().reset();
  
  // Reset Global State
  APP_STATE = {
    wpd: 0, kwhPerTurbine: 0, buildings: 0, hasData: false, 
    timeSeriesData: null, buildingRaster: null, centerPoint: null
  };
  
  var point = ee.Geometry.Point(coords.lon, coords.lat);
  APP_STATE.centerPoint = point;
  
  // Show site immediately
  Map.addLayer(point, 
    {color: CONFIG.UI.TURBINE_COLOR, pointSize: CONFIG.UI.TURBINE_SIZE}, 
    'Turbine Location (Center)'
  );

  // --- Step 1: Calculate Weather Time Series ---
  var dailyData = ee.FeatureCollection(
    ee.List.sequence(0, 364).map(function(n) {
      var dayStart = startDate.advance(n, 'day');
      var dayEnd = dayStart.advance(1, 'day');
      var dailyImages = weatherSeries.filterDate(dayStart, dayEnd);
      
      var processed = dailyImages.map(function(img) {
        var u = img.select('100m_u_component_of_wind');
        var v = img.select('100m_v_component_of_wind');
        
        // 1. Calculate Wind Speed
        var speed = u.hypot(v);
        
        // 2. Calculate Wind Power Density (WPD)
        // Formula: P/A = 0.5 * rho * v^3
        var wpd = speed.pow(3).multiply(0.5 * CONFIG.PHYSICS.AIR_DENSITY).rename('WPD');
        
        // 3. Calculate Turbine Power Output
        // Formula: P = WPD * Area * Cp
        var radius = CONFIG.PHYSICS.ROTOR_DIAMETER_M / 2.0;
        var area = Math.PI * (radius * radius); // Area swept by blades
        var rawPowerW = wpd.multiply(area).multiply(CONFIG.PHYSICS.SYSTEM_EFFICIENCY);
        
        // 4. Apply Realistic Power Curve
        // - Cut-in speed: 3 m/s (Turbine won't turn below this)
        // - Cut-out speed: 25 m/s (Turbine brakes for safety above this)
        // - Max Capacity: Clamped at 3000 kW (3MW)
        var generationKW = rawPowerW.divide(1000)
          .min(CONFIG.PHYSICS.MAX_GENERATION_KW) 
          .where(speed.lt(3).or(speed.gt(25)), 0)
          .rename('Generation_KW');
    
        return wpd.addBands(generationKW);
      });

      var means = processed.mean().reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: point,
        scale: 10000 // 10km scale is sufficient for weather model data
      });
      
      return ee.Feature(null, {
        'system:time_start': dayStart.millis(),
        'WPD': means.get('WPD'),
        'Daily_KWh_Per_Turbine': ee.Number(means.get('Generation_KW')).multiply(24)
      });
    })
  ).filter(ee.Filter.notNull(['WPD']));

  // --- Step 2: Calculate Building Density ---
  dailyData.size().evaluate(function(count) {
    if (count === 0) {
      statsPanel.clear();
      statsPanel.add(ui.Label('Error: No wind data available for this location.', {color: 'red'}));
      return;
    }
    
    // Aggregate weather stats
    var meanWPD = dailyData.aggregate_mean('WPD');
    var meanGen = dailyData.aggregate_mean('Daily_KWh_Per_Turbine');
    
    // Setup Raster Analysis
    var searchRadius = point.buffer(5000); 
    Map.centerObject(searchRadius);
    var buildingColl = ee.ImageCollection(CONFIG.DATA.BUILDING_COLLECTION);
    var latestRaster = buildingColl.sort('system:time_start', false).mosaic().clip(searchRadius);
    
    // Mask logic: High confidence + Minimum Height
    var mask = latestRaster.select('building_presence').gte(CONFIG.DATA.CONFIDENCE_THRESHOLD)
              .and(latestRaster.select('building_height').gte(CONFIG.DATA.MIN_HEIGHT_M));
    
    var buildingOnlyLayer = latestRaster.updateMask(mask).select('building_presence');
    
    var structureCount = latestRaster.updateMask(mask).reduceRegion({
      reducer: ee.Reducer.count(),
      geometry: searchRadius,
      scale: 10, // 10m scale for counting is efficient yet accurate enough
      maxPixels: 1e9
    });

    // --- Step 3: Evaluate & Update State ---
    meanWPD.evaluate(function(wpdVal) {
      meanGen.evaluate(function(genVal) {
        structureCount.evaluate(function(bCount) {
             APP_STATE.wpd = wpdVal;
             APP_STATE.kwhPerTurbine = genVal; 
             
             // Check if building count is valid (handles ocean clicks)
             APP_STATE.buildings = (bCount && bCount.building_presence) ? bCount.building_presence : 0;
             
             APP_STATE.timeSeriesData = dailyData; 
             APP_STATE.buildingRaster = buildingOnlyLayer; 
             APP_STATE.hasData = true;

             renderVisuals(); 
        });
      });
    });
  });
});

// ============================================================================
// 6. INITIALIZATION
// ============================================================================
Map.add(mainPanel);
Map.setOptions('SATELLITE');
Map.setCenter(CONFIG.UI.START_LON, CONFIG.UI.START_LAT, CONFIG.UI.START_ZOOM);
