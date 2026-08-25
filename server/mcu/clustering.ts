import { GeoLocation } from "./types";
import { haversineDistance } from "./geocoding";

const CLUSTER_DISTANCE_MILES = 20;

export interface MarketAreaCluster {
  id: string;
  name: string;
  locations: Array<{
    locationId: string;
    clientId: string;
    clientName: string;
    address: string;
    city: string;
    state: string;
    lat: number;
    lng: number;
  }>;
  centerLat: number;
  centerLng: number;
  primaryCity: string;
  state: string;
}

export function clusterLocationsIntoMarketAreas(
  locations: Array<{
    id: string;
    clientId: string;
    clientName: string;
    address: string;
    city: string;
    state: string;
    lat: number;
    lng: number;
    countyFips?: string | null;
    countyName?: string | null;
  }>
): MarketAreaCluster[] {
  if (locations.length === 0) return [];

  // Union-Find for transitive clustering
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(x: string, y: string): void {
    const rootX = find(x);
    const rootY = find(y);
    if (rootX === rootY) return;

    const rankX = rank.get(rootX) || 0;
    const rankY = rank.get(rootY) || 0;

    if (rankX < rankY) {
      parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      parent.set(rootY, rootX);
    } else {
      parent.set(rootY, rootX);
      rank.set(rootX, rankX + 1);
    }
  }

  // Initialize each location as its own cluster
  for (const loc of locations) {
    find(loc.id);
  }

  // Merge locations within 20 miles of each other
  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const locA = locations[i];
      const locB = locations[j];

      const distance = haversineDistance(locA.lat, locA.lng, locB.lat, locB.lng);

      if (distance <= CLUSTER_DISTANCE_MILES) {
        union(locA.id, locB.id);
      }
    }
  }

  // Group locations by their cluster root
  const clusters = new Map<string, typeof locations>();
  for (const loc of locations) {
    const root = find(loc.id);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(loc);
  }

  // Build MarketAreaCluster objects
  const marketAreas: MarketAreaCluster[] = [];

  for (const [clusterId, clusterLocs] of Array.from(clusters)) {
    // Find the largest city in the cluster (by location count, then alphabetically)
    const cityCount = new Map<string, number>();
    for (const loc of clusterLocs) {
      cityCount.set(loc.city, (cityCount.get(loc.city) || 0) + 1);
    }

    let primaryCity = clusterLocs[0].city;
    let maxCount = 0;
    for (const [city, count] of Array.from(cityCount)) {
      if (count > maxCount || (count === maxCount && city < primaryCity)) {
        primaryCity = city;
        maxCount = count;
      }
    }

    // Calculate center of the cluster
    let sumLat = 0, sumLng = 0;
    for (const loc of clusterLocs) {
      sumLat += loc.lat;
      sumLng += loc.lng;
    }
    const centerLat = sumLat / clusterLocs.length;
    const centerLng = sumLng / clusterLocs.length;

    // Use the most common state
    const stateCount = new Map<string, number>();
    for (const loc of clusterLocs) {
      stateCount.set(loc.state, (stateCount.get(loc.state) || 0) + 1);
    }
    let primaryState = clusterLocs[0].state;
    let maxStateCount = 0;
    for (const [state, count] of Array.from(stateCount)) {
      if (count > maxStateCount) {
        primaryState = state;
        maxStateCount = count;
      }
    }

    const uniqueCities = Array.from(cityCount.keys());
    const countyNames = new Set<string>();
    for (const loc of clusterLocs) {
      if (loc.countyName) countyNames.add(loc.countyName);
    }

    let clusterName: string;
    if (countyNames.size === 1) {
      const county = Array.from(countyNames)[0];
      clusterName = county.endsWith(" County") ? county : `${county} County`;
    } else if (countyNames.size > 1) {
      const countyArr = Array.from(countyNames).slice(0, 2);
      clusterName = countyArr.join(" / ") + " Metro";
    } else if (uniqueCities.length === 1) {
      clusterName = primaryCity;
    } else if (uniqueCities.length === 2) {
      clusterName = `${uniqueCities[0]}-${uniqueCities[1]}`;
    } else {
      clusterName = `${primaryCity} Metro`;
    }

    marketAreas.push({
      id: clusterId,
      name: clusterName,
      locations: clusterLocs.map(loc => ({
        locationId: loc.id,
        clientId: loc.clientId,
        clientName: loc.clientName,
        address: loc.address,
        city: loc.city,
        state: loc.state,
        lat: loc.lat,
        lng: loc.lng,
      })),
      centerLat,
      centerLng,
      primaryCity,
      state: primaryState,
    });
  }

  return marketAreas.sort((a, b) => a.name.localeCompare(b.name));
}

export function findMarketAreaForAddress(
  lat: number,
  lng: number,
  marketAreas: MarketAreaCluster[]
): MarketAreaCluster | null {
  for (const area of marketAreas) {
    for (const loc of area.locations) {
      const distance = haversineDistance(lat, lng, loc.lat, loc.lng);
      if (distance <= CLUSTER_DISTANCE_MILES) {
        return area;
      }
    }
  }
  return null;
}
