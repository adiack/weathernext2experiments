// Google Open Buildings v3 view with AlphaEarth embeddings
// Experimental script - CCBY4 
// --- 1. DYNAMIC GEOMETRY ---
// How to use it: Choose your current view on the map and click run 
// --- 1. CAPTURE THE VIEW ---
var bounds = Map.getBounds(true); 
var cityROI = ee.Geometry(bounds); 

// --- 2. DATA LOADING (LOCKED TO 2023) ---
var alphaEarth = ee.ImageCollection("GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL")
    .filterBounds(cityROI)
    .filter(ee.Filter.date('2023-01-01', '2023-12-31'))
    .first()
    .clip(cityROI);

var buildings25D = ee.ImageCollection('GOOGLE/Research/open-buildings-temporal/v1')
    .filterBounds(cityROI)
    .filter(ee.Filter.eq('inference_time_epoch_s', 1688108400))
    .mosaic()
    .clip(cityROI);

var buildingPresence = buildings25D.select('building_presence');

// --- 3. SURGICAL TRAINING (BUILDINGS ONLY) ---
// We mask AlphaEarth BEFORE sampling so the trainer ONLY sees building signatures.
var buildingMask = buildingPresence.gt(0.2);
var alphaOnlyBuildings = alphaEarth.updateMask(buildingMask);

var training = alphaOnlyBuildings.sample({
  region: cityROI,
  scale: 10, // Native resolution for high precision
  numPixels: 5000, 
  tileScale: 16,
  dropNulls: true // CRITICAL: This ignores non-building pixels
});

// Train Clusterer on the BUILDING signatures only
var clusterer = ee.Clusterer.wekaKMeans(6).train(training);

// Apply that "Building-Logic" to the whole city
var allClusters = alphaEarth.cluster(clusterer);

// Final visualization mask
var finalClusters = allClusters.updateMask(buildingMask);

// --- 4. VISUALIZATION ---
var clusterPalette = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4'];
var blackBackground = ee.Image(0).visualize({palette: ['#000000']});

Map.addLayer(blackBackground, {}, '1. Black Background');
Map.addLayer(finalClusters, {min: 0, max: 5, palette: clusterPalette}, '2. Surgical Building Clusters');

// --- 5. EXPORT ---
Export.image.toDrive({
  image: finalClusters.visualize({min: 0, max: 5, palette: clusterPalette}),
  description: 'ROI_2023_Building_Clusters',
  scale: 10,
  region: cityROI,
  fileFormat: 'GeoTIFF',
  maxPixels: 1e13
});
