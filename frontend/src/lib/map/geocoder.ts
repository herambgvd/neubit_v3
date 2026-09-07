"use client";

// Street- and building-level address search, served from OUR OWN box.
//
// Photon (komoot) over a prebuilt OpenStreetMap index, running as the `geocoder`
// service and routed at /geocode (see gateway/dynamic/routes.yml). Nothing leaves
// the deployment: the index is a file on disk, so this works on an air-gapped
// network and costs nothing per query — which is why it is here rather than a
// call to Google or the public Nominatim.
//
// It is OPTIONAL. The index is a few GB and takes minutes to provision, so every
// call site has to cope with it being absent; `probeGeocoder` exists for exactly
// that, and the map picker falls back to its built-in city gazetteer.

/** Same-origin, stripped back to Photon's own /api by the gateway. */
export const GEOCODER_URL = "/geocode";

/** Photon's `properties`. Only the fields a result row or a pin needs. */
export interface PhotonProperties {
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  /** house | street | locality | district | city | county | state | country | other */
  type?: string;
}

export interface GeocodeHit {
  lat: number;
  lng: number;
  /** The bold first line. */
  title: string;
  /** The grey second line — everything else that narrows it down. */
  detail: string;
  type: string;
  /** True when the hit is exact enough to drop the pin on without a click. */
  precise: boolean;
  zoom: number;
}

/**
 * A house or a street IS the point — that is the whole reason for this service,
 * and making the operator click again on a result they explicitly chose would be
 * pointless. Anything coarser (a city, a district) is a region, and its centre is
 * not a site: those only fly the map, exactly like a gazetteer hit.
 */
const PRECISE_TYPES = new Set(["house", "street"]);

const ZOOM_BY_TYPE: Record<string, number> = {
  house: 17,
  street: 16,
  locality: 15,
  district: 13,
  city: 11,
  county: 9,
  state: 7,
  country: 5,
};

/**
 * Photon returns fields, not a formatted address, so build one — and do it in the
 * order a person reads: what it is, then where, narrowing outward.
 */
export function formatHit(props: PhotonProperties): { title: string; detail: string } {
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const title = props.name || street || props.city || props.state || props.country || "Unnamed place";

  const parts = [
    // Only repeat the street line when the title was the building's own name.
    props.name && street ? street : "",
    props.locality,
    props.district,
    props.city,
    props.county && props.county !== props.city ? props.county : "",
    props.state,
    props.postcode,
    props.country,
  ];

  const seen = new Set([title.toLowerCase()]);
  const detail: string[] = [];
  for (const part of parts) {
    const value = (part || "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    detail.push(value);
  }
  return { title, detail: detail.join(", ") };
}

/** One Photon GeoJSON feature → the row the picker shows. */
export function toHit(feature: {
  geometry?: { coordinates?: unknown };
  properties?: PhotonProperties;
}): GeocodeHit | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords as number[];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const props = feature.properties || {};
  const type = props.type || "other";
  const { title, detail } = formatHit(props);
  return {
    lat,
    lng,
    title,
    detail,
    type,
    precise: PRECISE_TYPES.has(type),
    zoom: ZOOM_BY_TYPE[type] ?? 14,
  };
}

export interface GeocodeOptions {
  limit?: number;
  /** Bias results towards where the map is looking. */
  near?: { lat: number; lng: number };
  baseUrl?: string;
}

export async function geocode(query: string, options: GeocodeOptions = {}): Promise<GeocodeHit[]> {
  const { limit = 6, near, baseUrl = GEOCODER_URL } = options;
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: "en" });
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lng));
  }

  // No AbortSignal, deliberately: callers drop superseded answers with a
  // generation counter instead (see PlaceSearch). Aborting a local, debounced
  // request bought almost nothing and leaked AbortErrors into the dev overlay.
  const res = await fetch(`${baseUrl}/api?${params}`);
  if (!res.ok) throw new Error(`geocoder: HTTP ${res.status}`);
  const body = (await res.json()) as { features?: unknown[] };
  const features = Array.isArray(body?.features) ? body.features : [];
  return features
    .map((f) => toHit(f as Parameters<typeof toHit>[0]))
    .filter((hit): hit is GeocodeHit => hit !== null);
}

/** The address lines a site form holds, as this service can fill them. */
export interface ResolvedAddress {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  /** One line for a confirmation message. */
  label: string;
}

/**
 * Photon's fields, mapped onto the form's. The fallbacks matter: OSM has plenty
 * of places with a name and no street, or a district and no city, and a form
 * field left blank because the source used a different word for the same thing
 * is worse than one filled with the coarser answer.
 */
export function toAddress(props: PhotonProperties): ResolvedAddress {
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const { title, detail } = formatHit(props);
  return {
    street: street || props.name || props.locality || props.district || "",
    city: props.city || props.county || props.district || "",
    state: props.state || "",
    zipCode: props.postcode || "",
    country: props.country || "",
    label: [title, detail].filter(Boolean).join(", "),
  };
}

/**
 * What is AT this point? Used after the operator drops a pin, so the site's
 * address does not have to be typed twice.
 *
 * Returns null rather than throwing when there is nothing there or the service
 * is absent: a pin in the middle of a field is a legitimate site location, and
 * failing to name it must not stop the operator using the coordinates.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
  options: { baseUrl?: string } = {},
): Promise<ResolvedAddress | null> {
  const { baseUrl = GEOCODER_URL } = options;
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), lang: "en" });
  try {
    const res = await fetch(`${baseUrl}/reverse?${params}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { features?: { properties?: PhotonProperties }[] };
    const props = body?.features?.[0]?.properties;
    return props ? toAddress(props) : null;
  } catch {
    return null;
  }
}

/**
 * Is the service installed at all?/**
 * Is the service installed at all? Cached for the session — the answer only
 * changes when someone provisions the index, which is a restart away anyway.
 * A failure is NOT cached, so a picker opened while the index was still
 * unpacking will find it on the next try.
 */
let availability: Promise<boolean> | null = null;

export function probeGeocoder(baseUrl = GEOCODER_URL): Promise<boolean> {
  if (!availability) {
    availability = fetch(`${baseUrl}/status`)
      .then((res) => res.ok)
      .catch(() => false)
      .then((ok) => {
        if (!ok) availability = null;
        return ok;
      });
  }
  return availability;
}

/** Test seam — the cache above would otherwise leak between cases. */
export function resetGeocoder(): void {
  availability = null;
}
