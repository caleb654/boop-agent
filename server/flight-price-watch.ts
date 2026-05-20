/**
 * Scheduled flight fare checks backed by the local `fli` CLI.
 *
 * Configure watches through FLIGHT_PRICE_WATCHES_JSON. Example:
 * [
 *   {
 *     "kind": "itinerary",
 *     "name": "Southwest DEN",
 *     "origin": "DTW",
 *     "destination": "DEN",
 *     "departureDate": "2026-06-15",
 *     "paidPrice": 300,
 *     "passengerCount": 1,
 *     "airlines": ["WN"],
 *     "outboundFlightNumbers": ["1778"],
 *     "minSavings": 25
 *   },
 *   {
 *     "kind": "deal",
 *     "name": "Denver weekend",
 *     "origin": "DTW",
 *     "destination": "DEN",
 *     "startDate": "2026-06-01",
 *     "endDate": "2026-07-31",
 *     "duration": 3,
 *     "roundTrip": true,
 *     "maxPrice": 180
 *   }
 * ]
 */

import {
  CabinClass,
  FliDatePrice,
  FliFlight,
  FliFlightLeg,
  FliStops,
  searchCheapestDates,
  searchFlights,
} from "./integrations/fli.js";
import { sendLocalImessage } from "./local-imessage.js";

type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

interface BaseWatch {
  kind?: "itinerary" | "deal";
  name?: string;
  origin: string;
  destination: string;
  airlines?: string[];
  cabinClass?: CabinClass;
  class?: CabinClass;
  stops?: FliStops;
  maxStops?: FliStops;
  time?: string;
  departureWindow?: string;
  currency?: string;
}

interface ItineraryWatch extends BaseWatch {
  kind?: "itinerary";
  departureDate: string;
  returnDate?: string;
  flightNumbers?: string[];
  outboundFlightNumbers?: string[];
  returnFlightNumbers?: string[];
  passengerCount?: number;
  paidPrice?: number;
  bookedPrice?: number;
  minSavings?: number;
  thresholdSavings?: number;
}

interface DealWatch extends BaseWatch {
  kind: "deal";
  startDate: string;
  endDate: string;
  duration?: number;
  roundTrip?: boolean;
  maxPrice?: number;
  days?: Weekday[];
}

type FlightWatch = ItineraryWatch | DealWatch;

interface ItineraryResult {
  watch: ItineraryWatch;
  lowest: FliFlight | null;
  paidPrice: number | null;
  currentTotal: number | null;
  savings: number | null;
  shouldAlert: boolean;
}

interface DealResult {
  watch: DealWatch;
  matches: FliDatePrice[];
  cheapest: FliDatePrice | null;
  shouldAlert: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[flight-price-watch] each watch must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(obj: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`[flight-price-watch] missing required field: ${key}`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`[flight-price-watch] ${key} must be a string`);
  return value;
}

function asNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[flight-price-watch] ${key} must be a number`);
  }
  return value;
}

function asBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw new Error(`[flight-price-watch] ${key} must be a boolean`);
  return value;
}

function asStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`[flight-price-watch] ${key} must be an array of strings`);
  }
  return value;
}

function parseWatch(raw: unknown): FlightWatch {
  const obj = asRecord(raw);
  const kind = (asString(obj, "kind", false) ?? "itinerary") as "itinerary" | "deal";
  if (kind !== "itinerary" && kind !== "deal") {
    throw new Error("[flight-price-watch] kind must be itinerary or deal");
  }

  const base = {
    kind,
    name: asString(obj, "name", false),
    origin: asString(obj, "origin")!,
    destination: asString(obj, "destination")!,
    airlines: asStringArray(obj, "airlines"),
    cabinClass: (asString(obj, "cabinClass", false) ?? asString(obj, "class", false)) as CabinClass | undefined,
    maxStops: (asString(obj, "maxStops", false) ?? asString(obj, "stops", false)) as FliStops | undefined,
    departureWindow: asString(obj, "departureWindow", false) ?? asString(obj, "time", false),
    currency: asString(obj, "currency", false),
  };

  if (kind === "deal") {
    return {
      ...base,
      kind: "deal",
      startDate: asString(obj, "startDate")!,
      endDate: asString(obj, "endDate")!,
      duration: asNumber(obj, "duration"),
      roundTrip: asBoolean(obj, "roundTrip"),
      maxPrice: asNumber(obj, "maxPrice"),
      days: asStringArray(obj, "days") as Weekday[] | undefined,
    };
  }

  return {
    ...base,
    kind: "itinerary",
    departureDate: asString(obj, "departureDate")!,
    returnDate: asString(obj, "returnDate", false),
    flightNumbers: asStringArray(obj, "flightNumbers"),
    outboundFlightNumbers: asStringArray(obj, "outboundFlightNumbers"),
    returnFlightNumbers: asStringArray(obj, "returnFlightNumbers"),
    passengerCount: asNumber(obj, "passengerCount"),
    paidPrice: asNumber(obj, "paidPrice"),
    bookedPrice: asNumber(obj, "bookedPrice"),
    minSavings: asNumber(obj, "minSavings"),
    thresholdSavings: asNumber(obj, "thresholdSavings"),
  };
}

function loadWatches(): FlightWatch[] {
  const raw = process.env.FLIGHT_PRICE_WATCHES_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("[flight-price-watch] FLIGHT_PRICE_WATCHES_JSON must be a JSON array");
  }
  return parsed.map(parseWatch);
}

function resolveRecipients(): string[] {
  const list = (process.env.FLIGHT_PRICE_WATCH_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  const fallback = (process.env.BOOP_USER_PHONE ?? "").trim();
  return fallback ? [fallback] : [];
}

function money(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function normalizeFlightNumber(n: string): string {
  return n.trim().replace(/^0+/, "") || "0";
}

function watchName(watch: BaseWatch): string {
  return watch.name ?? `${watch.origin.toUpperCase()} -> ${watch.destination.toUpperCase()}`;
}

function allLegs(flight: FliFlight): Array<{ label: "out" | "return"; leg: FliFlightLeg }> {
  const out = flight.outbound?.legs ?? flight.legs ?? [];
  const ret = flight.return?.legs ?? [];
  return [
    ...out.map((leg) => ({ label: "out" as const, leg })),
    ...ret.map((leg) => ({ label: "return" as const, leg })),
  ];
}

function flightNumbersFor(flight: FliFlight): string[] {
  return allLegs(flight)
    .map(({ leg }) => leg.flight_number)
    .filter((n): n is string => Boolean(n))
    .map(normalizeFlightNumber);
}

function segmentFlightNumbers(flight: FliFlight, segment: "outbound" | "return"): string[] {
  const legs = segment === "outbound" ? (flight.outbound?.legs ?? flight.legs ?? []) : (flight.return?.legs ?? []);
  return legs
    .map((leg) => leg.flight_number)
    .filter((n): n is string => Boolean(n))
    .map(normalizeFlightNumber);
}

function sequenceEquals(actual: string[], expected: string[] | undefined): boolean {
  if (!expected?.length) return true;
  const normalized = expected.map(normalizeFlightNumber);
  return actual.length === normalized.length && actual.every((n, i) => n === normalized[i]);
}

function matchesExpectedFlights(flight: FliFlight, watch: ItineraryWatch): boolean {
  return (
    sequenceEquals(flightNumbersFor(flight), watch.flightNumbers) &&
    sequenceEquals(segmentFlightNumbers(flight, "outbound"), watch.outboundFlightNumbers) &&
    sequenceEquals(segmentFlightNumbers(flight, "return"), watch.returnFlightNumbers)
  );
}

function flightSummary(flight: FliFlight): string {
  const legs = allLegs(flight);
  const first = legs[0]?.leg;
  const last = legs[legs.length - 1]?.leg;
  const flightNums = legs
    .map(({ leg }) => leg)
    .map((leg) => `${leg.airline.code}${leg.flight_number ? ` ${leg.flight_number}` : ""}`)
    .join("/");
  const stops = flight.stops === 0 ? "nonstop" : `${flight.stops} total stops`;
  return `${flightNums} ${first?.departure_time ?? "?"} -> ${last?.arrival_time ?? "?"} (${stops})`;
}

function minSavingsFor(watch: ItineraryWatch): number {
  return watch.minSavings ?? watch.thresholdSavings ?? Number(process.env.FLIGHT_PRICE_MIN_SAVINGS_USD ?? 25);
}

function passengerCountFor(watch: ItineraryWatch): number {
  const count = watch.passengerCount ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`[flight-price-watch] passengerCount must be a positive integer for ${watchName(watch)}`);
  }
  return count;
}

async function checkItinerary(watch: ItineraryWatch): Promise<ItineraryResult> {
  const data = await searchFlights({
    origin: watch.origin,
    destination: watch.destination,
    departureDate: watch.departureDate,
    returnDate: watch.returnDate,
    airlines: watch.airlines,
    cabinClass: watch.cabinClass ?? watch.class,
    maxStops: watch.maxStops ?? watch.stops,
    departureWindow: watch.departureWindow ?? watch.time,
    currency: watch.currency,
  });
  const candidates = data.flights.filter((f) => matchesExpectedFlights(f, watch));
  const lowest = candidates
    .filter((f) => typeof f.price === "number" && Number.isFinite(f.price))
    .sort((a, b) => a.price - b.price)[0] ?? null;
  const paidPrice = watch.paidPrice ?? watch.bookedPrice ?? null;
  const currentTotal = lowest ? lowest.price * passengerCountFor(watch) : null;
  const savings = currentTotal !== null && paidPrice !== null ? paidPrice - currentTotal : null;
  return {
    watch,
    lowest,
    paidPrice,
    currentTotal,
    savings,
    shouldAlert: savings !== null && savings >= minSavingsFor(watch),
  };
}

async function checkDeal(watch: DealWatch): Promise<DealResult> {
  const data = await searchCheapestDates({
    origin: watch.origin,
    destination: watch.destination,
    from: watch.startDate,
    to: watch.endDate,
    duration: watch.duration,
    roundTrip: watch.roundTrip,
    airlines: watch.airlines,
    cabinClass: watch.cabinClass ?? watch.class,
    maxStops: watch.maxStops ?? watch.stops,
    departureWindow: watch.departureWindow ?? watch.time,
    currency: watch.currency,
    days: watch.days,
    sort: true,
  });
  const dates = data.dates
    .filter((d) => typeof d.price === "number" && Number.isFinite(d.price))
    .sort((a, b) => a.price - b.price);
  const maxPrice = watch.maxPrice;
  const matches = maxPrice === undefined ? dates.slice(0, 3) : dates.filter((d) => d.price <= maxPrice);
  return {
    watch,
    matches: matches.slice(0, 5),
    cheapest: dates[0] ?? null,
    shouldAlert: matches.length > 0,
  };
}

function formatItineraryAlert(result: ItineraryResult): string | null {
  if (!result.lowest || result.paidPrice === null || result.savings === null || result.currentTotal === null) return null;
  const currency = result.lowest.currency;
  const passengers = passengerCountFor(result.watch);
  const perPerson = passengers > 1 ? ` (${money(result.lowest.price, currency)} x ${passengers})` : "";
  return `${watchName(result.watch)}: rebook check looks worth it. Current lowest ${money(
    result.currentTotal,
    currency,
  )}${perPerson}, paid ${money(result.paidPrice, currency)}, save about ${money(result.savings, currency)}. ${flightSummary(
    result.lowest,
  )}`;
}

function formatDealAlert(result: DealResult): string | null {
  if (result.matches.length === 0) return null;
  const options = result.matches
    .map((d) => {
      const ret = d.return_date ? `-${d.return_date}` : "";
      return `${d.departure_date}${ret} ${money(d.price, d.currency)}`;
    })
    .join("; ");
  const threshold = result.watch.maxPrice ? ` under ${money(result.watch.maxPrice, result.matches[0]!.currency)}` : "";
  return `${watchName(result.watch)}: found ${result.matches.length} fare date${result.matches.length === 1 ? "" : "s"}${threshold}. ${options}`;
}

function formatNoChange(results: Array<ItineraryResult | DealResult>): string {
  const lines = results.map((result) => {
    if ("lowest" in result) {
      const low = result.lowest;
      if (!low) return `${watchName(result.watch)}: no fares returned`;
      const current = result.currentTotal ?? low.price;
      const passengers = passengerCountFor(result.watch);
      const perPerson = passengers > 1 ? ` (${money(low.price, low.currency)} x ${passengers})` : "";
      const paid = result.paidPrice === null ? "" : ` vs paid ${money(result.paidPrice, low.currency)}`;
      return `${watchName(result.watch)}: lowest ${money(current, low.currency)}${perPerson}${paid}`;
    }
    if (!result.cheapest) return `${watchName(result.watch)}: no dates returned`;
    return `${watchName(result.watch)}: cheapest ${result.cheapest.departure_date} ${money(
      result.cheapest.price,
      result.cheapest.currency,
    )}`;
  });
  return `Flight watch: no rebook/deal alerts.\n\n${lines.join("\n")}`;
}

export async function runFlightPriceWatch(): Promise<{ result: string }> {
  const watches = loadWatches();
  if (watches.length === 0) {
    return { result: "No flight watches configured (set FLIGHT_PRICE_WATCHES_JSON)" };
  }

  const results: Array<ItineraryResult | DealResult> = [];
  for (const watch of watches) {
    results.push(watch.kind === "deal" ? await checkDeal(watch) : await checkItinerary(watch));
  }

  const alerts = results
    .filter((result) => result.shouldAlert)
    .map((result) => ("lowest" in result ? formatItineraryAlert(result) : formatDealAlert(result)))
    .filter((line): line is string => Boolean(line));
  const shouldSend = alerts.length > 0 || process.env.FLIGHT_PRICE_WATCH_NOTIFY_NO_CHANGE === "true";
  const message = alerts.length > 0 ? `Flight price alert\n\n${alerts.join("\n\n")}` : formatNoChange(results);

  if (shouldSend) {
    const recipients = resolveRecipients();
    if (recipients.length === 0 && process.env.FLIGHT_PRICE_WATCH_DRY_RUN !== "true") {
      throw new Error("[flight-price-watch] no recipients configured (set FLIGHT_PRICE_WATCH_TO or BOOP_USER_PHONE)");
    }
    if (process.env.FLIGHT_PRICE_WATCH_DRY_RUN === "true") {
      console.log(`[flight-price-watch] dry run message:\n${message}`);
    } else {
      for (const recipient of recipients) {
        await sendLocalImessage(recipient, message);
      }
    }
  }

  return {
    result:
      `Checked ${watches.length} flight watch(es); ` +
      `${alerts.length} alert(s)${shouldSend ? " sent/evaluated for delivery" : " and no message sent"}`,
  };
}
