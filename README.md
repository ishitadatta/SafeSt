# HCI Project Mobile App

This app is located at:

`/Users/ishitadatta/GeorgiaTech/Sem 1/HCI Foundations/Project/mobile-app`

## Run

```bash
cd "/Users/ishitadatta/GeorgiaTech/Sem 1/HCI Foundations/Project/mobile-app"
npm install
npm run start
```

Then:
- Press `i` for iOS simulator
- Press `a` for Android emulator
- Or scan the QR code with Expo Go

## Implemented
- Real map rendering using `react-native-maps`
- Current location support via `expo-location`
- Typed origin/destination geocoding via Nominatim
- Multi-route walking alternatives via OSRM (`Route A/B/C`)
- Safety scoring per route:
  - street-lamp density (OpenStreetMap Overpass)
  - crowd unsafe reports near route
  - route duration and time-of-day adjustment
- User unsafe-point reporting:
  - report from current location during walk
  - red markers shown on map
- Multi-stage navigation flow (search, route options, walking, arrived)
# SafeSt
