import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CabinClass = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
export type FliStops = "ANY" | "NON_STOP" | "ONE_STOP" | "TWO_PLUS_STOPS" | "0" | "1" | "2" | "2+";
export type FliSort =
  | "TOP_FLIGHTS"
  | "BEST"
  | "CHEAPEST"
  | "DEPARTURE_TIME"
  | "ARRIVAL_TIME"
  | "DURATION"
  | "EMISSIONS";

export interface FliAirport {
  code: string;
  name?: string;
}

export interface FliAirline {
  code: string;
  name?: string;
}

export interface FliFlightLeg {
  departure_airport: FliAirport;
  arrival_airport: FliAirport;
  departure_time: string;
  arrival_time: string;
  duration: number;
  airline: FliAirline;
  flight_number?: string;
}

export interface FliFlight {
  duration: number;
  stops: number;
  legs?: FliFlightLeg[];
  outbound?: {
    duration: number;
    stops: number;
    legs: FliFlightLeg[];
  };
  return?: {
    duration: number;
    stops: number;
    legs: FliFlightLeg[];
  };
  price: number;
  currency: string;
}

export interface FliFlightSearchResponse {
  success: boolean;
  search_type: "flights";
  count: number;
  flights: FliFlight[];
}

export interface FliDatePrice {
  departure_date: string;
  return_date: string | null;
  price: number;
  currency: string;
}

export interface FliDateSearchResponse {
  success: boolean;
  search_type: "dates";
  count: number;
  dates: FliDatePrice[];
}

export interface SearchFlightsOptions {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  departureWindow?: string;
  airlines?: string[];
  cabinClass?: CabinClass;
  maxStops?: FliStops;
  sortBy?: FliSort;
  excludeBasic?: boolean;
  bags?: number;
  carryOn?: boolean;
  currency?: string;
}

export interface SearchDatesOptions {
  origin: string;
  destination: string;
  from: string;
  to: string;
  duration?: number;
  roundTrip?: boolean;
  departureWindow?: string;
  airlines?: string[];
  cabinClass?: CabinClass;
  maxStops?: FliStops;
  sort?: boolean;
  currency?: string;
  days?: Array<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday">;
}

function normalizeIata(code: string): string {
  return code.trim().toUpperCase();
}

function pushOptional(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined || value === "") return;
  args.push(flag, String(value));
}

function normalizeStops(stops: FliStops | undefined): string | undefined {
  if (stops === "2+") return "TWO_PLUS_STOPS";
  return stops;
}

async function runFliJson<T>(args: string[]): Promise<T> {
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync("fli", args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const maybe = err as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (maybe.code === "ENOENT") {
      throw new Error("[fli] fli CLI is not installed. Install it with: pipx install flights");
    }
    const body = [maybe.stderr, maybe.stdout, maybe.message].filter(Boolean).join("\n").trim();
    throw new Error(`[fli] command failed: ${body || String(err)}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`[fli] expected JSON output, got: ${stdout.slice(0, 500)}${stderr ? ` ${stderr}` : ""}`);
  }
}

export async function searchFlights(
  options: SearchFlightsOptions,
): Promise<FliFlightSearchResponse> {
  const args = [
    "flights",
    normalizeIata(options.origin),
    normalizeIata(options.destination),
    options.departureDate,
    "--format",
    "json",
    "--currency",
    options.currency ?? "USD",
  ];
  pushOptional(args, "--return", options.returnDate);
  pushOptional(args, "--time", options.departureWindow);
  if (options.airlines?.length) pushOptional(args, "--airlines", options.airlines.map(normalizeIata).join(","));
  pushOptional(args, "--class", options.cabinClass);
  pushOptional(args, "--stops", normalizeStops(options.maxStops));
  pushOptional(args, "--sort", options.sortBy ?? "CHEAPEST");
  if (options.excludeBasic) args.push("--exclude-basic");
  if (options.bags !== undefined) pushOptional(args, "--bags", options.bags);
  if (options.carryOn) args.push("--carry-on");

  const data = await runFliJson<FliFlightSearchResponse>(args);
  if (!data.success || !Array.isArray(data.flights)) {
    throw new Error(`[fli] unexpected flights response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

export async function searchCheapestDates(
  options: SearchDatesOptions,
): Promise<FliDateSearchResponse> {
  const args = [
    "dates",
    normalizeIata(options.origin),
    normalizeIata(options.destination),
    "--from",
    options.from,
    "--to",
    options.to,
    "--format",
    "json",
    "--currency",
    options.currency ?? "USD",
  ];
  pushOptional(args, "--duration", options.duration);
  if (options.roundTrip) args.push("--round");
  pushOptional(args, "--time", options.departureWindow);
  if (options.airlines?.length) pushOptional(args, "--airlines", options.airlines.map(normalizeIata).join(","));
  pushOptional(args, "--class", options.cabinClass);
  pushOptional(args, "--stops", normalizeStops(options.maxStops));
  if (options.sort) args.push("--sort");
  for (const day of options.days ?? []) args.push(`--${day}`);

  const data = await runFliJson<FliDateSearchResponse>(args);
  if (!data.success || !Array.isArray(data.dates)) {
    throw new Error(`[fli] unexpected dates response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}
