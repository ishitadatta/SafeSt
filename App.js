import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const COLORS = {
  bg: "#e9edf4",
  navy: "#284c8f",
  navyDark: "#1f3c73",
  text: "#1b2533",
  card: "#ffffff",
  muted: "#70839d",
  border: "#d7deea",
  lavender: "#eeebf5",
  orange: "#d85e34",
  green: "#4f9f5f",
  error: "#a22e2e",
};

const MIDTOWN_ATLANTA = {
  latitude: 33.7768,
  longitude: -84.3892,
  latitudeDelta: 0.014,
  longitudeDelta: 0.014,
};

const QUIZ_IMAGES = {
  dayOpenStreet: require("./assets/quiz/from_pdf/img_0022.jpg"),
  activeStreetWithStores: require("./assets/quiz/from_pdf/img_0023.jpg"),
  nightLitSidewalk: require("./assets/quiz/from_pdf/img_0024.jpg"),
};

function haversineMeters(a, b) {
  const toRad = (n) => (n * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toProfileLevel(value) {
  if (value >= 2) return "High";
  if (value <= -1) return "Low";
  return "Medium";
}

async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "HCI-Safety-Navigator/1.0",
    },
  });

  if (!response.ok) {
    throw new Error("Could not find that location.");
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`No geocoding results for "${query}".`);
  }

  return {
    latitude: Number(results[0].lat),
    longitude: Number(results[0].lon),
    label: results[0].display_name,
  };
}

async function fetchWalkingRoutes(origin, destination) {
  const url =
    `https://router.project-osrm.org/route/v1/foot/` +
    `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Route service is unavailable right now.");
  }

  const data = await response.json();
  if (data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error("No valid walking routes were found.");
  }

  return data.routes.slice(0, 3).map((route) => {
    const coordinates = route.geometry.coordinates.map(([lng, lat]) => ({
      latitude: lat,
      longitude: lng,
    }));

    const steps = (route.legs?.[0]?.steps || []).map((step) => {
      const roadName = step.name || "the next segment";
      const modifier = step.maneuver?.modifier ? ` (${step.maneuver.modifier})` : "";
      return `${step.maneuver?.type || "continue"} on ${roadName}${modifier}`;
    });

    return {
      coordinates,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      steps,
    };
  });
}

function routeBBox(coords) {
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;

  coords.forEach((c) => {
    north = Math.max(north, c.latitude);
    south = Math.min(south, c.latitude);
    east = Math.max(east, c.longitude);
    west = Math.min(west, c.longitude);
  });

  const margin = 0.0018;
  return {
    south: south - margin,
    west: west - margin,
    north: north + margin,
    east: east + margin,
  };
}

async function fetchStreetLampCount(bbox) {
  const query = `[out:json][timeout:20];node["highway"="street_lamp"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out body;`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    return 0;
  }

  const data = await response.json();
  return Array.isArray(data.elements) ? data.elements.length : 0;
}

function countReportsNearRoute(reports, coords) {
  if (!reports.length || !coords.length) {
    return 0;
  }

  const sample = coords.filter((_, i) => i % 8 === 0 || i === coords.length - 1);
  return reports.filter((report) =>
    sample.some((point) => haversineMeters(point, report) < 90)
  ).length;
}

function isNightTime() {
  const hour = new Date().getHours();
  return hour >= 20 || hour <= 6;
}

function scoreRoute(route, lampCount, nearbyReports, profileWeights) {
  const distanceKm = Math.max(0.1, route.distanceMeters / 1000);
  const durationMin = route.durationSeconds / 60;
  const lampDensity = lampCount / distanceKm;

  const lightingWeight = profileWeights?.lightingWeight || 1;
  const reportWeight = profileWeights?.reportWeight || 1;
  const speedWeight = profileWeights?.speedWeight || 1;

  let score = 100;
  score -= Math.min(28, durationMin * 0.9 * speedWeight);
  score -= Math.min(54, nearbyReports * 16 * reportWeight);

  if (lampDensity < 2) {
    score -= 16 * lightingWeight;
  } else {
    score += Math.min(20, lampDensity * 1.4 * lightingWeight);
  }

  if (isNightTime()) {
    score -= 12;
  }

  score = clamp(Math.round(score), 0, 100);

  const tags = [];
  tags.push(lampDensity >= 4 ? "good lighting" : "low lighting");
  tags.push(nearbyReports === 0 ? "no nearby reports" : `${nearbyReports} nearby reports`);
  tags.push(durationMin <= 10 ? "quick route" : "longer route");

  return { score, tags, lampDensity };
}

function minutesFromSeconds(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

function formatMiles(meters) {
  return (meters / 1609.34).toFixed(2);
}

export default function App() {
  const mapRef = useRef(null);
  const [showSplash, setShowSplash] = useState(true);

  const [tab, setTab] = useState("nav");
  const [navStage, setNavStage] = useState("search");
  const [quizIndex, setQuizIndex] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const [mapModule, setMapModule] = useState(null);
  const [mapLoadError, setMapLoadError] = useState("");

  const [originInput, setOriginInput] = useState("Georgia Tech, Atlanta");
  const [destinationInput, setDestinationInput] = useState("Ponce City Market, Atlanta");
  const [originCoord, setOriginCoord] = useState(null);
  const [destinationCoord, setDestinationCoord] = useState(null);

  const [routes, setRoutes] = useState([]);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  const [activeStep, setActiveStep] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [currentLocation, setCurrentLocation] = useState(null);
  const [reports, setReports] = useState([]);
  const [mapCenter, setMapCenter] = useState({
    latitude: MIDTOWN_ATLANTA.latitude,
    longitude: MIDTOWN_ATLANTA.longitude,
  });
  const [reportNotice, setReportNotice] = useState("");
  const [quizSelections, setQuizSelections] = useState({});
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [userSafetyProfile, setUserSafetyProfile] = useState(null);
  const [streetMode, setStreetMode] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, []);

  const selectedRoute = routes[selectedRouteIdx] || null;

  const quizCards = useMemo(
    () => [
      {
        id: "lighting",
        a: "Night street with active lighting and clear walking path",
        b: "Open street section with lower active oversight",
        aImage: QUIZ_IMAGES.nightLitSidewalk,
        bImage: QUIZ_IMAGES.dayOpenStreet,
        effects: {
          A: { lighting: 2, report: 2, speed: 0 },
          B: { lighting: 0, report: -1, speed: 1 },
        },
      },
      {
        id: "construction",
        a: "Sidewalk with storefront activity and visible pedestrian flow",
        b: "Street segment with fewer nearby people",
        aImage: QUIZ_IMAGES.activeStreetWithStores,
        bImage: QUIZ_IMAGES.dayOpenStreet,
        effects: {
          A: { lighting: 1, report: 2, speed: 0 },
          B: { lighting: 0, report: -1, speed: 1 },
        },
      },
      {
        id: "visibility",
        a: "Street with bike lane, police presence, and multiple active cues",
        b: "Quiet street segment with fewer immediate safety cues",
        aImage: QUIZ_IMAGES.activeStreetWithStores,
        bImage: QUIZ_IMAGES.dayOpenStreet,
        effects: {
          A: { lighting: 1, report: 2, speed: 0 },
          B: { lighting: -1, report: -1, speed: 1 },
        },
      },
    ],
    []
  );

  const focusMap = (coords) => {
    if (!mapRef.current || !coords || coords.length === 0) {
      return;
    }

    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 70, right: 40, bottom: 120, left: 40 },
      animated: true,
    });
  };

  const ensureCurrentLocation = async () => {
    if (currentLocation) {
      return currentLocation;
    }

    const Location = await import("expo-location");
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") {
      throw new Error("Location permission denied.");
    }

    const position = await Location.getCurrentPositionAsync({});
    const coord = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
    setCurrentLocation(coord);
    return coord;
  };

  const loadMapModule = () => {
    try {
      const maps = require("react-native-maps");
      const MapViewComponent = maps.default || maps;
      const MarkerComponent = maps.Marker || MapViewComponent?.Marker || null;
      const PolylineComponent = maps.Polyline || MapViewComponent?.Polyline || null;

      if (!MapViewComponent || !MarkerComponent || !PolylineComponent) {
        throw new Error("react-native-maps exports are incomplete.");
      }

      setMapModule({
        MapViewComponent,
        MarkerComponent,
        PolylineComponent,
      });
      setMapLoadError("");
      setShowMap(true);
    } catch (error) {
      setMapModule(null);
      setMapLoadError(String(error?.message || "Map module unavailable."));
      setShowMap(true);
    }
  };

  const resolveOrigin = async () => {
    const normalized = originInput.trim().toLowerCase();
    if (normalized === "my location" || normalized === "current location") {
      return ensureCurrentLocation();
    }
    const geocoded = await geocodePlace(originInput);
    return { latitude: geocoded.latitude, longitude: geocoded.longitude };
  };

  const calculateSafetyProfile = (selections) => {
    const totals = { lighting: 0, report: 0, speed: 0 };

    quizCards.forEach((card, idx) => {
      const choice = selections[idx];
      if (!choice) return;
      const effect = card.effects?.[choice];
      if (!effect) return;

      totals.lighting += effect.lighting;
      totals.report += effect.report;
      totals.speed += effect.speed;
    });

    return {
      lightingPriority: toProfileLevel(totals.lighting),
      cautionPriority: toProfileLevel(totals.report),
      pacePreference: totals.speed >= 2 ? "Fastest Route" : totals.speed <= 0 ? "Safer Route" : "Balanced",
      weights: {
        lightingWeight: clamp(1 + totals.lighting * 0.18, 0.6, 1.9),
        reportWeight: clamp(1 + totals.report * 0.18, 0.6, 2.0),
        speedWeight: clamp(1 + totals.speed * 0.15, 0.7, 1.7),
      },
    };
  };

  const onQuizSelect = (choice) => {
    setQuizSelections((prev) => ({
      ...prev,
      [quizIndex]: choice,
    }));
  };

  const onNextQuiz = () => {
    const currentChoice = quizSelections[quizIndex];
    if (!currentChoice) {
      return;
    }

    if (quizIndex < quizCards.length - 1) {
      setQuizIndex((prev) => prev + 1);
      return;
    }

    const profile = calculateSafetyProfile(quizSelections);
    setUserSafetyProfile(profile);
    setQuizCompleted(true);
  };

  const retakeQuiz = () => {
    setQuizSelections({});
    setQuizIndex(0);
    setQuizCompleted(false);
  };

  const scoreAllRoutes = async (rawRoutes, activeReports) => {
    const scored = [];
    const profileWeights = userSafetyProfile?.weights;

    for (let i = 0; i < rawRoutes.length; i += 1) {
      const route = rawRoutes[i];
      const bbox = routeBBox(route.coordinates);
      const lampCount = await fetchStreetLampCount(bbox);
      const nearbyReports = countReportsNearRoute(activeReports, route.coordinates);
      const rating = scoreRoute(route, lampCount, nearbyReports, profileWeights);

      scored.push({
        ...route,
        name: `Route ${String.fromCharCode(65 + i)}`,
        score: rating.score,
        tags: rating.tags,
        lampDensity: rating.lampDensity,
        nearbyReports,
      });
    }

    return scored.sort((a, b) => b.score - a.score);
  };

  const buildRoutes = async () => {
    if (!originInput.trim() || !destinationInput.trim()) {
      setErrorMessage("Enter both origin and destination.");
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    setReportNotice("");

    try {
      const from = await resolveOrigin();
      const toGeocoded = await geocodePlace(destinationInput);
      const to = { latitude: toGeocoded.latitude, longitude: toGeocoded.longitude };

      const rawRoutes = await fetchWalkingRoutes(from, to);
      const scoredRoutes = await scoreAllRoutes(rawRoutes, reports);

      setOriginCoord(from);
      setDestinationCoord(to);
      setRoutes(scoredRoutes);
      setSelectedRouteIdx(0);
      setActiveStep(0);
      setNavStage("routes");

      setTimeout(() => {
        focusMap(scoredRoutes[0]?.coordinates || []);
      }, 120);
    } catch (error) {
      setErrorMessage(error.message || "Could not generate routes.");
    } finally {
      setIsLoading(false);
    }
  };

  const addUnsafeReport = async () => {
    let point = selectedRoute?.coordinates?.[activeStep] || null;

    if (!point && currentLocation) {
      point = currentLocation;
    }

    if (!point && originCoord) {
      point = originCoord;
    }

    if (!point && mapCenter) {
      point = mapCenter;
    }

    if (!point) {
      setErrorMessage("No location available to report. Enable location permissions.");
      return;
    }

    const newReport = {
      id: `${Date.now()}`,
      latitude: point.latitude,
      longitude: point.longitude,
      createdAt: new Date().toISOString(),
    };

    const updated = [newReport, ...reports].slice(0, 120);
    setReports(updated);
    setReportNotice("Unsafe spot reported. Route scores updated.");

    if (routes.length > 0) {
      const rescored = await scoreAllRoutes(
        routes.map((r) => ({
          coordinates: r.coordinates,
          distanceMeters: r.distanceMeters,
          durationSeconds: r.durationSeconds,
          steps: r.steps,
        })),
        updated
      );
      setRoutes(rescored);
      setSelectedRouteIdx(0);
      setActiveStep(0);
    }
  };

  const nextStep = () => {
    if (!selectedRoute) {
      return;
    }

    if (activeStep < selectedRoute.steps.length - 1) {
      setActiveStep((prev) => prev + 1);
      return;
    }
    setNavStage("arrived");
  };

  const openStreetViewAtCurrentStep = async () => {
    const point = selectedRoute?.coordinates?.[activeStep] || destinationCoord || originCoord;
    if (!point) {
      setErrorMessage("No location available for street view.");
      return;
    }

    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${point.latitude},${point.longitude}`;
    try {
      await Linking.openURL(url);
    } catch {
      setErrorMessage("Could not open street view.");
    }
  };

  const streetModeVisual = () => {
    const step = (selectedRoute?.steps?.[activeStep] || "").toLowerCase();
    if (step.includes("left")) {
      return "https://source.unsplash.com/1200x700/?street,intersection,left-turn";
    }
    if (step.includes("right")) {
      return "https://source.unsplash.com/1200x700/?street,intersection,right-turn";
    }
    return "https://source.unsplash.com/1200x700/?road,street,forward,city";
  };

  const resetNavigation = () => {
    setNavStage("search");
    setRoutes([]);
    setSelectedRouteIdx(0);
    setActiveStep(0);
    setErrorMessage("");
    setReportNotice("");
    setStreetMode(false);
  };

  const renderHeader = (title, subtitle) => (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>{title}</Text>
      {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
    </View>
  );

  const renderRealMap = () => (
    mapModule ? (
      <mapModule.MapViewComponent
        ref={mapRef}
        style={styles.map}
        initialRegion={MIDTOWN_ATLANTA}
        onRegionChangeComplete={(region) =>
          setMapCenter({ latitude: region.latitude, longitude: region.longitude })
        }
        showsUserLocation
        showsMyLocationButton
      >
        {originCoord ? (
          <mapModule.MarkerComponent coordinate={originCoord} title="Origin" pinColor="#e3b23c" />
        ) : null}
        {destinationCoord ? (
          <mapModule.MarkerComponent coordinate={destinationCoord} title="Destination" pinColor={COLORS.orange} />
        ) : null}

        {routes.map((route, idx) => (
          <mapModule.PolylineComponent
            key={`${route.name}-${idx}`}
            coordinates={route.coordinates}
            strokeColor={idx === selectedRouteIdx ? COLORS.navy : "#95a8c8"}
            strokeWidth={idx === selectedRouteIdx ? 6 : 3}
          />
        ))}

        {reports.map((report) => (
          <mapModule.MarkerComponent
            key={report.id}
            coordinate={{ latitude: report.latitude, longitude: report.longitude }}
            title="Unsafe Report"
            description="Community flagged this point"
            pinColor="#cc2f2f"
          />
        ))}
      </mapModule.MapViewComponent>
    ) : (
      <View style={styles.mapFallback}>
        <Text style={styles.mapFallbackTitle}>Map could not load</Text>
        <Text style={styles.mapFallbackBody}>
          Fix dependencies and reload. Details: {mapLoadError}
        </Text>
        <Pressable style={styles.mapLoadBtn} onPress={loadMapModule}>
          <Text style={styles.mapLoadBtnText}>Retry Map Load</Text>
        </Pressable>
      </View>
    )
  );

  const renderMapPanel = () => (
    <View style={styles.mapCard}>
      {showMap ? (
        renderRealMap()
      ) : (
        <View style={styles.mapFallback}>
          <Text style={styles.mapFallbackTitle}>Map preview is off</Text>
          <Text style={styles.mapFallbackBody}>
            Tap below to load the live map module.
          </Text>
          <Pressable style={styles.mapLoadBtn} onPress={loadMapModule}>
            <Text style={styles.mapLoadBtnText}>Load Map</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  const renderSearchStage = () => (
    <>
      {renderHeader("Where do you want to go?", "Live map + safety scoring")}
      <View style={styles.card}>
        <Text style={styles.inputLabel}>Origin</Text>
        <TextInput
          value={originInput}
          onChangeText={setOriginInput}
          placeholder='Try "my location" or "Georgia Tech"'
          style={styles.input}
          placeholderTextColor="#8f9bb2"
        />

        <Text style={styles.inputLabel}>Destination</Text>
        <TextInput
          value={destinationInput}
          onChangeText={setDestinationInput}
          placeholder='Try "Piedmont Park, Atlanta"'
          style={styles.input}
          placeholderTextColor="#8f9bb2"
        />

        {renderMapPanel()}

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {isLoading ? <ActivityIndicator color={COLORS.navy} style={styles.loading} /> : null}

        <Pressable style={styles.primaryBtn} onPress={buildRoutes} disabled={isLoading}>
          <Text style={styles.primaryBtnText}>Calculate Safe Routes</Text>
        </Pressable>
      </View>
    </>
  );

  const renderRouteStage = () => (
    <>
      {renderHeader(
        "Route Suggestions",
        userSafetyProfile
          ? "Ranked using your safety profile + map signals"
          : "Safety score based on lights + reports"
      )}
      <View style={styles.card}>
        {renderMapPanel()}

        {routes.map((route, idx) => (
          <Pressable
            key={route.name}
            style={[styles.routeRow, idx === selectedRouteIdx ? styles.routeRowSelected : null]}
            onPress={() => {
              setSelectedRouteIdx(idx);
              setActiveStep(0);
              focusMap(route.coordinates);
            }}
          >
            <View style={styles.routeTextBlock}>
              <Text style={styles.routeName}>{route.name}</Text>
              <Text style={styles.routeDetail}>
                {formatMiles(route.distanceMeters)} mi • {minutesFromSeconds(route.durationSeconds)} min • Score {route.score}
              </Text>
              <View style={styles.chipsRow}>
                {route.tags.map((tag) => (
                  <Chip key={`${route.name}-${tag}`} text={tag} />
                ))}
              </View>
            </View>
          </Pressable>
        ))}

        <Text style={styles.reportCount}>Total unsafe reports on map: {reports.length}</Text>
        {userSafetyProfile ? (
          <Text style={styles.profileApplied}>
            Profile applied: {userSafetyProfile.lightingPriority} lighting, {userSafetyProfile.cautionPriority} caution
          </Text>
        ) : null}

        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryBtn} onPress={() => setNavStage("search")}>
            <Text style={styles.secondaryBtnText}>Back</Text>
          </Pressable>
          <Pressable style={styles.primaryBtnSmall} onPress={() => setNavStage("walking")}>
            <Text style={styles.primaryBtnText}>Start Walking</Text>
          </Pressable>
        </View>
      </View>
    </>
  );

  const renderWalkingStage = () => (
    <>
      {renderHeader("Navigation", streetMode ? "Street guidance mode" : "Map guidance mode")}
      <View style={styles.card}>
        {streetMode ? (
          <View style={styles.streetModeCard}>
            <Image source={{ uri: streetModeVisual() }} style={styles.streetModeImage} />
            <Text style={styles.streetModeTitle}>Street Guidance View</Text>
            <Text style={styles.streetModeNote}>
              Use this for road-level context. Tap below for live panorama at your current step.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={openStreetViewAtCurrentStep}>
              <Text style={styles.primaryBtnText}>Open Live Street View</Text>
            </Pressable>
          </View>
        ) : (
          renderMapPanel()
        )}
        <View style={styles.stepBox}>
          <Text style={styles.stepLabel}>Current Step</Text>
          <Text style={styles.stepText}>
            {selectedRoute?.steps?.[activeStep] || "Follow the highlighted route."}
          </Text>
          <Text style={styles.stepMeta}>
            Step {Math.min(activeStep + 1, selectedRoute?.steps?.length || 1)} of {Math.max(selectedRoute?.steps?.length || 1, 1)}
          </Text>
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={styles.sosBtn} onPress={addUnsafeReport}>
            <Text style={styles.sosText}>Report Unsafe Spot</Text>
          </Pressable>
          <Pressable style={styles.primaryBtnSmall} onPress={nextStep}>
            <Text style={styles.primaryBtnText}>Next Step</Text>
          </Pressable>
        </View>
        <Pressable
          style={styles.secondaryBtn}
          onPress={() => setStreetMode((prev) => !prev)}
        >
          <Text style={styles.secondaryBtnText}>
            {streetMode ? "Switch to Map View" : "Switch to Street View"}
          </Text>
        </Pressable>
        {reportNotice ? <Text style={styles.reportNotice}>{reportNotice}</Text> : null}
      </View>
    </>
  );

  const renderArrivedStage = () => (
    <>
      {renderHeader("You have arrived!", "Trip completed")}
      <View style={styles.card}>
        {renderMapPanel()}
        <View style={styles.arrivedBar}>
          <Text style={styles.arrivedText}>Arrived</Text>
          <Pressable style={styles.exitBtn} onPress={resetNavigation}>
            <Text style={styles.exitText}>EXIT</Text>
          </Pressable>
        </View>
      </View>
    </>
  );

  const renderNavigation = () => {
    if (navStage === "search") return renderSearchStage();
    if (navStage === "routes") return renderRouteStage();
    if (navStage === "walking") return renderWalkingStage();
    return renderArrivedStage();
  };

  const renderNetwork = () => (
    <>
      {renderHeader("Safety Network", "Recent friends and requests")}
      <View style={styles.card}>
        {[
          ["AN", "Ava Nguyen", "450m away"],
          ["RM", "Rohan Mehta", "2.1 km away"],
          ["SK", "Sofia Kim", "1.3 km away"],
          ["DM", "Diego Morales", "900m away"],
        ].map((row) => (
          <View key={row[0]} style={styles.friendRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{row[0]}</Text>
            </View>
            <View style={styles.friendBody}>
              <Text style={styles.friendName}>{row[1]}</Text>
              <Text style={styles.friendMeta}>{row[2]}</Text>
            </View>
            <Pressable style={styles.inviteBtn}>
              <Text style={styles.inviteText}>Invite</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </>
  );

  const renderQuiz = () => (
    <>
      {quizCompleted ? (
        <>
          {renderHeader("Safety Profile", "Based on your quiz preferences")}
          <View style={styles.card}>
            <Text style={styles.profileTitle}>Your personalized safety profile</Text>
            <View style={styles.profileRow}>
              <Text style={styles.profileKey}>Lighting priority</Text>
              <Text style={styles.profileVal}>{userSafetyProfile?.lightingPriority || "Medium"}</Text>
            </View>
            <View style={styles.profileRow}>
              <Text style={styles.profileKey}>Caution level</Text>
              <Text style={styles.profileVal}>{userSafetyProfile?.cautionPriority || "Medium"}</Text>
            </View>
            <View style={styles.profileRow}>
              <Text style={styles.profileKey}>Route preference</Text>
              <Text style={styles.profileVal}>{userSafetyProfile?.pacePreference || "Balanced"}</Text>
            </View>

            <Text style={styles.profileNote}>
              Route A/B/C scoring now uses this profile when ranking recommendations.
            </Text>

            <View style={styles.buttonRow}>
              <Pressable style={styles.secondaryBtn} onPress={retakeQuiz}>
                <Text style={styles.secondaryBtnText}>Retake Quiz</Text>
              </Pressable>
              <Pressable
                style={styles.primaryBtnSmall}
                onPress={() => {
                  setTab("nav");
                  setNavStage("search");
                }}
              >
                <Text style={styles.primaryBtnText}>Use in Routes</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : (
        <>
          {renderHeader("Personalization Quiz", `Question ${quizIndex + 1} of ${quizCards.length}`)}
          <View style={styles.card}>
            <Text style={styles.questionTitle}>Which street image feels safer?</Text>
            <OptionCard
              label="Option A"
              text={quizCards[quizIndex].a}
              imageUri={quizCards[quizIndex].aImage}
              selected={quizSelections[quizIndex] === "A"}
              onPress={() => onQuizSelect("A")}
            />
            <OptionCard
              label="Option B"
              text={quizCards[quizIndex].b}
              imageUri={quizCards[quizIndex].bImage}
              selected={quizSelections[quizIndex] === "B"}
              onPress={() => onQuizSelect("B")}
            />
            {quizSelections[quizIndex] ? (
              <Text style={styles.quizSelected}>
                You marked Option {quizSelections[quizIndex]} as safer.
              </Text>
            ) : (
              <Text style={styles.quizHint}>Select one option to continue.</Text>
            )}
            <Pressable
              style={[
                styles.primaryBtn,
                !quizSelections[quizIndex] ? styles.disabledBtn : null,
              ]}
              onPress={onNextQuiz}
              disabled={!quizSelections[quizIndex]}
            >
              <Text style={styles.primaryBtnText}>
                {quizIndex === quizCards.length - 1 ? "Finish Quiz" : "Next Question"}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </>
  );

  const renderSettings = () => (
    <>
      {renderHeader("Settings", "Safety preferences and permissions")}
      <View style={styles.card}>
        {[
          "Location Sharing Time",
          "SOS Preferences",
          "Personalization Quiz",
          "About Scoring System",
          "Community Rules",
        ].map((item) => (
          <View key={item} style={styles.settingRow}>
            <Text style={styles.settingText}>{item}</Text>
            <Text style={styles.chev}>{">"}</Text>
          </View>
        ))}
        <View style={styles.notesBox}>
          <Text style={styles.notesText}>
            Safety score uses route duration, street-lamp density from OpenStreetMap, and crowd unsafe reports.
          </Text>
        </View>
      </View>
    </>
  );

  if (showSplash) {
    return (
      <SafeAreaView style={styles.splashScreen}>
        <View style={styles.splashLogo}>
          <Text style={styles.splashLogoText}>SAFE</Text>
        </View>
        <Text style={styles.splashTitle}>Safety Navigator</Text>
        <Text style={styles.splashSub}>Safer routes for every walk.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {tab === "nav" ? renderNavigation() : null}
        {tab === "network" ? renderNetwork() : null}
        {tab === "quiz" ? renderQuiz() : null}
        {tab === "settings" ? renderSettings() : null}
      </ScrollView>

      <View style={styles.tabBar}>
        <TabItem label="Nav" icon="⌖" active={tab === "nav"} onPress={() => setTab("nav")} />
        <TabItem label="Friends" icon="♥" active={tab === "network"} onPress={() => setTab("network")} />
        <TabItem label="Quiz" icon="◈" active={tab === "quiz"} onPress={() => setTab("quiz")} />
        <TabItem
          label="Settings"
          icon="⚙"
          active={tab === "settings"}
          onPress={() => setTab("settings")}
        />
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function Chip({ text }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{text}</Text>
    </View>
  );
}

function OptionCard({ label, text, imageUri, onPress, selected }) {
  const [failed, setFailed] = useState(false);

  return (
    <Pressable style={[styles.optionCard, selected ? styles.optionCardSelected : null]} onPress={onPress}>
      {failed ? (
        <View style={styles.imageFallback}>
          <Text style={styles.imageFallbackText}>Image unavailable</Text>
          <Text style={styles.imageFallbackSub}>Please retry app launch</Text>
        </View>
      ) : (
        <Image
          source={{ uri: imageUri }}
          style={styles.imagePlaceholder}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      )}
      <Text style={styles.optionLabel}>{label}</Text>
      <Text style={styles.optionText}>{text}</Text>
    </Pressable>
  );
}

function TabItem({ label, icon, active, onPress }) {
  return (
    <Pressable style={styles.tabItem} onPress={onPress}>
      <Text style={[styles.tabIcon, active ? styles.tabIconActive : null]}>{icon}</Text>
      <Text style={[styles.tabLabel, active ? styles.tabLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  splashScreen: {
    flex: 1,
    backgroundColor: COLORS.navy,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  splashLogo: {
    backgroundColor: "#ffffff",
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 14,
  },
  splashLogoText: {
    color: COLORS.navy,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 1,
  },
  splashTitle: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "800",
  },
  splashSub: {
    marginTop: 8,
    color: "#dbe7ff",
    fontSize: 15,
  },
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  screen: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 90,
    gap: 10,
  },
  header: {
    backgroundColor: COLORS.navy,
    borderRadius: 24,
    padding: 16,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 25,
    fontWeight: "700",
  },
  headerSub: {
    color: "#d9e3f6",
    marginTop: 4,
    fontSize: 13,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    minHeight: 520,
  },
  inputLabel: {
    color: COLORS.navyDark,
    fontWeight: "700",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
    color: COLORS.text,
    fontSize: 14,
    backgroundColor: "#fbfcfe",
  },
  mapCard: {
    height: 260,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
    marginBottom: 12,
  },
  map: {
    width: "100%",
    height: "100%",
  },
  mapFallback: {
    flex: 1,
    backgroundColor: "#f5f7fb",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  mapFallbackTitle: {
    color: COLORS.error,
    fontWeight: "700",
    marginBottom: 6,
  },
  mapFallbackBody: {
    color: COLORS.text,
    fontSize: 12,
    textAlign: "center",
    marginBottom: 10,
  },
  mapLoadBtn: {
    backgroundColor: COLORS.navy,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    minWidth: 140,
    alignItems: "center",
  },
  mapLoadBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
  streetModeCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
    backgroundColor: "#f8fafd",
  },
  streetModeImage: {
    width: "100%",
    height: 180,
    borderRadius: 10,
    marginBottom: 8,
  },
  streetModeTitle: {
    color: COLORS.navyDark,
    fontWeight: "700",
    marginBottom: 4,
  },
  streetModeNote: {
    color: COLORS.muted,
    fontSize: 12,
    marginBottom: 8,
  },
  loading: {
    marginBottom: 8,
  },
  errorText: {
    color: COLORS.error,
    marginBottom: 8,
    fontWeight: "600",
  },
  routeRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  routeRowSelected: {
    backgroundColor: COLORS.lavender,
    borderColor: COLORS.navy,
  },
  routeTextBlock: {
    gap: 2,
  },
  routeName: {
    color: COLORS.navyDark,
    fontWeight: "800",
  },
  routeDetail: {
    color: COLORS.muted,
    fontSize: 12,
    marginBottom: 5,
  },
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "#dbe8ff",
  },
  chipText: {
    fontSize: 10,
    color: "#1a315e",
  },
  reportCount: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 8,
  },
  profileApplied: {
    color: COLORS.navy,
    fontSize: 12,
    marginBottom: 8,
    fontWeight: "600",
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    gap: 8,
  },
  primaryBtn: {
    backgroundColor: COLORS.navy,
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: "center",
  },
  disabledBtn: {
    opacity: 0.45,
  },
  primaryBtnSmall: {
    flex: 1,
    backgroundColor: COLORS.navy,
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: "#edf2fb",
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  secondaryBtnText: {
    color: COLORS.navy,
    fontWeight: "700",
    fontSize: 14,
  },
  stepBox: {
    backgroundColor: "#f4f7fe",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    marginBottom: 10,
  },
  stepLabel: {
    color: COLORS.navyDark,
    fontWeight: "700",
    marginBottom: 4,
  },
  stepText: {
    color: COLORS.text,
    lineHeight: 20,
  },
  stepMeta: {
    color: COLORS.muted,
    marginTop: 4,
    fontSize: 12,
  },
  sosBtn: {
    flex: 1,
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: "center",
  },
  sosText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  reportNotice: {
    marginTop: 8,
    color: "#1d5f39",
    fontWeight: "600",
    fontSize: 12,
  },
  arrivedBar: {
    backgroundColor: COLORS.navy,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  arrivedText: {
    color: "#fff",
    fontWeight: "700",
  },
  exitBtn: {
    backgroundColor: COLORS.orange,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  exitText: {
    color: "#fff",
    fontWeight: "800",
  },
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f7",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 99,
    backgroundColor: "#7f7dd7",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "700",
  },
  friendBody: {
    flex: 1,
    marginLeft: 10,
  },
  friendName: {
    color: COLORS.text,
    fontWeight: "700",
  },
  friendMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  inviteBtn: {
    backgroundColor: COLORS.navy,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  inviteText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  questionTitle: {
    color: COLORS.navyDark,
    fontWeight: "700",
    marginBottom: 10,
    fontSize: 16,
  },
  optionCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  optionCardSelected: {
    borderColor: COLORS.navy,
    backgroundColor: "#eef3ff",
  },
  imagePlaceholder: {
    width: "100%",
    height: 150,
    borderRadius: 8,
    marginBottom: 8,
  },
  imageFallback: {
    width: "100%",
    height: 150,
    borderRadius: 8,
    marginBottom: 8,
    backgroundColor: "#dfe5f1",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  imageFallbackText: {
    color: COLORS.navyDark,
    fontWeight: "700",
    marginBottom: 4,
  },
  imageFallbackSub: {
    color: COLORS.muted,
    fontSize: 12,
    textAlign: "center",
  },
  optionLabel: {
    color: COLORS.navy,
    fontWeight: "800",
  },
  optionText: {
    color: COLORS.text,
    marginTop: 2,
  },
  quizSelected: {
    color: COLORS.navy,
    fontWeight: "600",
    marginBottom: 8,
  },
  quizHint: {
    color: COLORS.muted,
    marginBottom: 8,
  },
  profileTitle: {
    color: COLORS.navyDark,
    fontWeight: "700",
    fontSize: 17,
    marginBottom: 10,
  },
  profileRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f7",
  },
  profileKey: {
    color: COLORS.text,
    fontWeight: "600",
  },
  profileVal: {
    color: COLORS.navy,
    fontWeight: "700",
  },
  profileNote: {
    color: COLORS.muted,
    marginTop: 12,
    marginBottom: 14,
    lineHeight: 18,
  },
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  settingText: {
    color: COLORS.text,
    fontWeight: "600",
  },
  chev: {
    color: COLORS.muted,
    fontSize: 18,
  },
  notesBox: {
    marginTop: 8,
    backgroundColor: COLORS.lavender,
    borderRadius: 10,
    padding: 10,
  },
  notesText: {
    color: COLORS.text,
    lineHeight: 19,
  },
  tabBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  tabItem: {
    width: "24%",
    alignItems: "center",
    paddingVertical: 3,
    borderRadius: 8,
  },
  tabIcon: {
    fontSize: 17,
    color: COLORS.muted,
  },
  tabIconActive: {
    color: COLORS.navy,
  },
  tabLabel: {
    fontSize: 11,
    color: COLORS.muted,
    marginTop: 2,
  },
  tabLabelActive: {
    color: COLORS.navy,
    fontWeight: "700",
  },
});
