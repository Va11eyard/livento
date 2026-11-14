/**
 * TheSportsDB client (server-only): real upcoming NBA, NFL, MLB, NHL and MLS games
 * near the user, from the free public API (documented key "123", no sign-up).
 * Docs: https://www.thesportsdb.com/documentation · Terms: https://www.thesportsdb.com/docs_terms_of_use.php
 *
 * Free-tier facts this module is built around (checked 2026-11-14):
 * - Documented: 30 requests/minute, a 429 means wait a minute. Observed: the free key
 *   returns 429 after ~10 quick calls and stays locked for 1–2 minutes. So we spend at
 *   most 8 calls per minute (counted in lib/kv, so shared across instances when Redis is
 *   set) and stop for 2 minutes after a 429, serving cached games meanwhile.
 * - eventsnext.php (a team's next events) returns ONE event on the free key: the team's
 *   next game by UTC date, home or away (a game played earlier that UTC day can still be
 *   returned after it ends). League/day/season lists return 1/3/15 events, so we ask per
 *   local team instead (nearest first) and keep only games at a local home venue.
 * - No ticket prices. Times are UTC (strTimestamp); the local date and time are computed
 *   in the home team's time zone.
 * - Terms: mention TheSportsDB as the data source and link back where appropriate. Artwork
 *   is mostly fan-made: event thumbs are shown only with their event, credited.
 *
 * Responses are cached in lib/kv: a team's next game for 4 hours (12 hours when it has no
 * upcoming game), a 48-hour backup used when the API fails or the budget is spent, and
 * event lookups for 4 hours. Every function fails soft (empty list / null).
 */
import { distanceMiles, isLatLng, type LatLng } from "./geo";
import { kvGet, kvIncr, kvSet } from "./kv";
import type { LiventoEvent } from "./types";

const API_BASE = "https://www.thesportsdb.com/api/v1/json/123";
const TIMEOUT_MS = 4_000;
/** Hard cap for the whole lookup so Discover never waits long on this source. */
const OVERALL_TIMEOUT_MS = 5_000;
const FRESH_TTL_SECONDS = 4 * 3_600;
const EMPTY_TTL_SECONDS = 12 * 3_600;
const STALE_TTL_SECONDS = 48 * 3_600;
const EVENT_TTL_SECONDS = 4 * 3_600;
const MISSING_TTL_SECONDS = 3_600;
const BUDGET_WINDOW_SECONDS = 60;
const BUDGET_CALLS_PER_WINDOW = 8;
const COOLDOWN_SECONDS = 120;
/** Nearest local teams considered per query; only uncached ones cost an API call. */
const MAX_TEAMS_PER_QUERY = 12;
const DEFAULT_RADIUS_MILES = 50;

export const TSDB_ATTRIBUTION = "Event data: TheSportsDB";

// ---------------------------------------------------------------------------
// Leagues and teams
// ---------------------------------------------------------------------------

export type SportsLeague = "NBA" | "NFL" | "MLB" | "NHL" | "MLS";

/** League ids verified against the API (lookups and eventsnextleague, 2026-11-14). */
const LEAGUES: Record<SportsLeague, { id: string; sport: string; schedule: string }> = {
  NBA: { id: "4387", sport: "Basketball", schedule: "https://www.nba.com/schedule" },
  NFL: { id: "4391", sport: "Football", schedule: "https://www.nfl.com/schedules/" },
  MLB: { id: "4424", sport: "Baseball", schedule: "https://www.mlb.com/schedule" },
  NHL: { id: "4380", sport: "Hockey", schedule: "https://www.nhl.com/schedule" },
  MLS: { id: "4346", sport: "Soccer", schedule: "https://www.mlssoccer.com/schedule/scores" },
};

interface Team {
  id: string; // TheSportsDB idTeam
  league: SportsLeague;
  name: string;
  city: string; // municipality of the home venue
  state: string; // US state / Canadian province code
  lat: number; // home venue, approximate
  lng: number;
  tz: string; // IANA time zone of the home venue
  venueId?: string; // TheSportsDB idVenue of the home venue
  site?: string; // official team site (from TheSportsDB)
}

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const AZ = "America/Phoenix";
const PT = "America/Los_Angeles";
const TOR = "America/Toronto";
const WPG = "America/Winnipeg";
const EDM = "America/Edmonton";
const VAN = "America/Vancouver";

const CANADA = new Set(["ON", "QC", "BC", "AB", "MB"]);

type Row = [string, SportsLeague, string, string, string, number, number, string, string, string];

/**
 * Team ids, names, home venue ids and sites come from TheSportsDB; venue coordinates
 * and time zones are a static mapping (approximate, used for distance and local time).
 * Columns: idTeam, league, name, city, state, lat, lng, time zone, idVenue, site.
 */
const ROWS: Row[] = [
  // NBA
  ["134880", "NBA", "Atlanta Hawks", "Atlanta", "GA", 33.7573, -84.3963, ET, "21308", "www.nba.com/hawks"],
  ["134860", "NBA", "Boston Celtics", "Boston", "MA", 42.3662, -71.0621, ET, "24786", "www.nba.com/celtics"],
  ["134861", "NBA", "Brooklyn Nets", "Brooklyn", "NY", 40.6826, -73.9754, ET, "23447", "www.nba.com/nets"],
  ["134881", "NBA", "Charlotte Hornets", "Charlotte", "NC", 35.2251, -80.8392, ET, "24838", "www.nba.com/hornets"],
  ["134870", "NBA", "Chicago Bulls", "Chicago", "IL", 41.8807, -87.6742, CT, "22727", "www.nba.com/bulls"],
  ["134871", "NBA", "Cleveland Cavaliers", "Cleveland", "OH", 41.4965, -81.6882, ET, "22906", "www.cavs.com"],
  ["134875", "NBA", "Dallas Mavericks", "Dallas", "TX", 32.7905, -96.8103, CT, "19860", "www.mavs.com"],
  ["134885", "NBA", "Denver Nuggets", "Denver", "CO", 39.7487, -105.0077, MT, "24848", "www.nba.com/nuggets"],
  ["134872", "NBA", "Detroit Pistons", "Detroit", "MI", 42.3411, -83.0553, ET, "24835", "www.nba.com/pistons"],
  ["134865", "NBA", "Golden State Warriors", "San Francisco", "CA", 37.768, -122.3877, PT, "24828", "www.warriors.com"],
  ["134876", "NBA", "Houston Rockets", "Houston", "TX", 29.7508, -95.3621, CT, "19870", "www.rockets.com"],
  ["134873", "NBA", "Indiana Pacers", "Indianapolis", "IN", 39.764, -86.1555, ET, "24847", "www.pacers.com"],
  ["134866", "NBA", "Los Angeles Clippers", "Inglewood", "CA", 33.9447, -118.341, PT, "30970", "www.nba.com/clippers"],
  ["134867", "NBA", "Los Angeles Lakers", "Los Angeles", "CA", 34.043, -118.2673, PT, "25994", "www.lakers.com"],
  ["134877", "NBA", "Memphis Grizzlies", "Memphis", "TN", 35.1382, -90.0506, CT, "24727", "www.grizzlies.com"],
  ["134882", "NBA", "Miami Heat", "Miami", "FL", 25.7814, -80.187, ET, "28619", "www.heat.com"],
  ["134874", "NBA", "Milwaukee Bucks", "Milwaukee", "WI", 43.0451, -87.9172, CT, "24837", "www.bucks.com"],
  ["134886", "NBA", "Minnesota Timberwolves", "Minneapolis", "MN", 44.9795, -93.276, CT, "23207", "www.timberwolves.com"],
  ["134878", "NBA", "New Orleans Pelicans", "New Orleans", "LA", 29.949, -90.0821, CT, "24819", "www.pelicans.com"],
  ["134862", "NBA", "New York Knicks", "New York", "NY", 40.7505, -73.9934, ET, "16006", "www.nba.com/knicks"],
  ["134887", "NBA", "Oklahoma City Thunder", "Oklahoma City", "OK", 35.4634, -97.5151, CT, "24852", "www.thunder.nba.com"],
  ["134883", "NBA", "Orlando Magic", "Orlando", "FL", 28.5392, -81.3839, ET, "18422", "www.orlandomagic.com"],
  ["134863", "NBA", "Philadelphia 76ers", "Philadelphia", "PA", 39.9012, -75.172, ET, "19333", "www.sixers.com"],
  ["134868", "NBA", "Phoenix Suns", "Phoenix", "AZ", 33.4457, -112.0712, AZ, "23213", "www.suns.com"],
  ["134888", "NBA", "Portland Trail Blazers", "Portland", "OR", 45.5316, -122.6668, PT, "24818", "www.blazers.com"],
  ["134869", "NBA", "Sacramento Kings", "Sacramento", "CA", 38.5802, -121.4997, PT, "24836", "www.kings.com"],
  ["134879", "NBA", "San Antonio Spurs", "San Antonio", "TX", 29.427, -98.4375, CT, "29950", "www.spurs.com"],
  ["134864", "NBA", "Toronto Raptors", "Toronto", "ON", 43.6435, -79.3791, TOR, "24830", "www.raptors.com"],
  ["134889", "NBA", "Utah Jazz", "Salt Lake City", "UT", 40.7683, -111.9011, MT, "29509", "www.utahjazz.com"],
  ["134884", "NBA", "Washington Wizards", "Washington", "DC", 38.8981, -77.0209, ET, "19331", "www.washingtonwizards.com"],
  // NFL
  ["134946", "NFL", "Arizona Cardinals", "Glendale", "AZ", 33.5276, -112.2626, AZ, "16027", "www.azcardinals.com"],
  ["134942", "NFL", "Atlanta Falcons", "Atlanta", "GA", 33.7554, -84.4008, ET, "16029", "www.atlantafalcons.com"],
  ["134922", "NFL", "Baltimore Ravens", "Baltimore", "MD", 39.278, -76.6227, ET, "21598", "www.baltimoreravens.com"],
  ["134918", "NFL", "Buffalo Bills", "Orchard Park", "NY", 42.7738, -78.787, ET, "33904", "www.buffalobills.com"],
  ["134943", "NFL", "Carolina Panthers", "Charlotte", "NC", 35.2258, -80.8528, ET, "18776", "www.panthers.com"],
  ["134938", "NFL", "Chicago Bears", "Chicago", "IL", 41.8623, -87.6167, CT, "16092", "www.chicagobears.com"],
  ["134923", "NFL", "Cincinnati Bengals", "Cincinnati", "OH", 39.0955, -84.5161, ET, "29569", "www.bengals.com"],
  ["134924", "NFL", "Cleveland Browns", "Cleveland", "OH", 41.5061, -81.6995, ET, "19480", "www.clevelandbrowns.com"],
  ["134934", "NFL", "Dallas Cowboys", "Arlington", "TX", 32.7473, -97.0945, CT, "15802", "www.dallascowboys.com"],
  ["134930", "NFL", "Denver Broncos", "Denver", "CO", 39.7439, -105.0201, MT, "18784", "www.denverbroncos.com"],
  ["134939", "NFL", "Detroit Lions", "Detroit", "MI", 42.34, -83.0456, ET, "15808", "www.detroitlions.com"],
  ["134940", "NFL", "Green Bay Packers", "Green Bay", "WI", 44.5013, -88.0622, CT, "17146", "www.packers.com"],
  ["134926", "NFL", "Houston Texans", "Houston", "TX", 29.6847, -95.4107, CT, "15873", "www.houstontexans.com"],
  ["134927", "NFL", "Indianapolis Colts", "Indianapolis", "IN", 39.7601, -86.1639, ET, "15807", "www.colts.com"],
  ["134928", "NFL", "Jacksonville Jaguars", "Jacksonville", "FL", 30.3239, -81.6373, ET, "29576", "www.jaguars.com"],
  ["134931", "NFL", "Kansas City Chiefs", "Kansas City", "MO", 39.0489, -94.4839, CT, "29575", "www.kcchiefs.com"],
  ["134932", "NFL", "Las Vegas Raiders", "Las Vegas", "NV", 36.0909, -115.1833, PT, "21293", "www.raiders.com"],
  ["135908", "NFL", "Los Angeles Chargers", "Inglewood", "CA", 33.9535, -118.3392, PT, "23720", "www.chargers.com"],
  ["135907", "NFL", "Los Angeles Rams", "Inglewood", "CA", 33.9535, -118.3392, PT, "23720", "www.therams.com"],
  ["134919", "NFL", "Miami Dolphins", "Miami Gardens", "FL", 25.958, -80.2389, ET, "20373", "www.miamidolphins.com"],
  ["134941", "NFL", "Minnesota Vikings", "Minneapolis", "MN", 44.9737, -93.2581, CT, "15803", "www.vikings.com"],
  ["134920", "NFL", "New England Patriots", "Foxborough", "MA", 42.0909, -71.2643, ET, "15816", "www.patriots.com"],
  ["134944", "NFL", "New Orleans Saints", "New Orleans", "LA", 29.9511, -90.0812, CT, "29571", "www.neworleanssaints.com"],
  ["134935", "NFL", "New York Giants", "East Rutherford", "NJ", 40.8135, -74.0745, ET, "15812", "www.giants.com"],
  ["134921", "NFL", "New York Jets", "East Rutherford", "NJ", 40.8135, -74.0745, ET, "15812", "www.newyorkjets.com"],
  ["134936", "NFL", "Philadelphia Eagles", "Philadelphia", "PA", 39.9008, -75.1675, ET, "16094", "philadelphiaeagles.com"],
  ["134925", "NFL", "Pittsburgh Steelers", "Pittsburgh", "PA", 40.4468, -80.0158, ET, "29572", "www.steelers.com"],
  ["134948", "NFL", "San Francisco 49ers", "Santa Clara", "CA", 37.403, -121.97, PT, "16090", "www.49ers.com"],
  ["134949", "NFL", "Seattle Seahawks", "Seattle", "WA", 47.5952, -122.3316, PT, "19833", "www.seahawks.com"],
  ["134945", "NFL", "Tampa Bay Buccaneers", "Tampa", "FL", 27.9759, -82.5033, ET, "15874", "www.buccaneers.com"],
  ["134929", "NFL", "Tennessee Titans", "Nashville", "TN", 36.1665, -86.7713, CT, "30912", "www.tennesseetitans.com"],
  ["134937", "NFL", "Washington Commanders", "Landover", "MD", 38.9076, -76.8645, ET, "29574", "commanders.com"],
  // MLB
  ["135267", "MLB", "Arizona Diamondbacks", "Phoenix", "AZ", 33.4455, -112.0667, AZ, "21627", "www.mlb.com/dbacks"],
  ["135261", "MLB", "Athletics", "West Sacramento", "CA", 38.5803, -121.5137, PT, "31213", "www.mlb.com/athletics"],
  ["135268", "MLB", "Atlanta Braves", "Atlanta", "GA", 33.8908, -84.4678, ET, "30815", "www.atlantabraves.com"],
  ["135251", "MLB", "Baltimore Orioles", "Baltimore", "MD", 39.2839, -76.6217, ET, "30843", "orioles.com"],
  ["135252", "MLB", "Boston Red Sox", "Boston", "MA", 42.3467, -71.0972, ET, "21630", "www.redsox.com"],
  ["135269", "MLB", "Chicago Cubs", "Chicago", "IL", 41.9484, -87.6553, CT, "30763", "www.mlb.com/cubs"],
  ["135253", "MLB", "Chicago White Sox", "Chicago", "IL", 41.8299, -87.6338, CT, "21631", "www.mlb.com/whitesox"],
  ["135270", "MLB", "Cincinnati Reds", "Cincinnati", "OH", 39.0975, -84.5066, ET, "30974", "www.mlb.com/reds"],
  ["135254", "MLB", "Cleveland Guardians", "Cleveland", "OH", 41.4962, -81.6852, ET, "30977", "www.mlb.com/guardians"],
  ["135271", "MLB", "Colorado Rockies", "Denver", "CO", 39.7559, -104.9942, MT, "30978", "www.mlb.com/rockies"],
  ["135255", "MLB", "Detroit Tigers", "Detroit", "MI", 42.339, -83.0485, ET, "28777", "www.mlb.com/tigers"],
  ["135256", "MLB", "Houston Astros", "Houston", "TX", 29.7573, -95.3555, CT, "30979", "www.mlb.com/astros"],
  ["135257", "MLB", "Kansas City Royals", "Kansas City", "MO", 39.0517, -94.4803, CT, "30848", "www.mlb.com/royals"],
  ["135258", "MLB", "Los Angeles Angels", "Anaheim", "CA", 33.8003, -117.8827, PT, "23214", "www.mlb.com/angels"],
  ["135272", "MLB", "Los Angeles Dodgers", "Los Angeles", "CA", 34.0739, -118.24, PT, "30849", "www.mlb.com/dodgers"],
  ["135273", "MLB", "Miami Marlins", "Miami", "FL", 25.7781, -80.2197, ET, "30985", "www.mlb.com/marlins"],
  ["135274", "MLB", "Milwaukee Brewers", "Milwaukee", "WI", 43.028, -87.9712, CT, "30986", "www.mlb.com/brewers"],
  ["135259", "MLB", "Minnesota Twins", "Minneapolis", "MN", 44.9817, -93.2776, CT, "30987", "www.mlb.com/twins"],
  ["135275", "MLB", "New York Mets", "Queens", "NY", 40.7571, -73.8458, ET, "23848", "www.mlb.com/mets"],
  ["135260", "MLB", "New York Yankees", "Bronx", "NY", 40.8296, -73.9262, ET, "19474", "www.mlb.com/yankees"],
  ["135276", "MLB", "Philadelphia Phillies", "Philadelphia", "PA", 39.9061, -75.1665, ET, "30640", "www.mlb.com/phillies"],
  ["135277", "MLB", "Pittsburgh Pirates", "Pittsburgh", "PA", 40.4469, -80.0057, ET, "30983", "www.mlb.com/pirates"],
  ["135278", "MLB", "San Diego Padres", "San Diego", "CA", 32.7073, -117.1566, PT, "15799", "www.mlb.com/padres"],
  ["135279", "MLB", "San Francisco Giants", "San Francisco", "CA", 37.7786, -122.3893, PT, "26529", "www.mlb.com/giants"],
  ["135262", "MLB", "Seattle Mariners", "Seattle", "WA", 47.5914, -122.3325, PT, "30988", "www.mlb.com/mariners"],
  ["135280", "MLB", "St. Louis Cardinals", "St. Louis", "MO", 38.6226, -90.1928, CT, "30855", "www.mlb.com/cardinals"],
  ["135263", "MLB", "Tampa Bay Rays", "St. Petersburg", "FL", 27.7683, -82.6534, ET, "20138", "www.mlb.com/rays"],
  ["135264", "MLB", "Texas Rangers", "Arlington", "TX", 32.7473, -97.0842, CT, "21752", "www.mlb.com/rangers"],
  ["135265", "MLB", "Toronto Blue Jays", "Toronto", "ON", 43.6414, -79.3894, TOR, "15805", "www.mlb.com/bluejays"],
  ["135281", "MLB", "Washington Nationals", "Washington", "DC", 38.873, -77.0074, ET, "30984", "nationals.com"],
  // NHL
  ["134846", "NHL", "Anaheim Ducks", "Anaheim", "CA", 33.8078, -117.8765, PT, "15587", "www.nhl.com/ducks"],
  ["134830", "NHL", "Boston Bruins", "Boston", "MA", 42.3662, -71.0621, ET, "24786", "www.nhl.com/bruins"],
  ["134831", "NHL", "Buffalo Sabres", "Buffalo", "NY", 42.875, -78.8764, ET, "24841", "www.nhl.com/sabres"],
  ["134848", "NHL", "Calgary Flames", "Calgary", "AB", 51.0374, -114.0519, EDM, "24784", "www.nhl.com/flames"],
  ["134838", "NHL", "Carolina Hurricanes", "Raleigh", "NC", 35.8033, -78.7219, ET, "24919", "www.nhl.com/hurricanes"],
  ["134854", "NHL", "Chicago Blackhawks", "Chicago", "IL", 41.8807, -87.6742, CT, "22727", "www.nhl.com/blackhawks"],
  ["134855", "NHL", "Colorado Avalanche", "Denver", "CO", 39.7487, -105.0077, MT, "24762", "www.nhl.com/avalanche"],
  ["134839", "NHL", "Columbus Blue Jackets", "Columbus", "OH", 39.9693, -83.0061, ET, "19854", "www.nhl.com/bluejackets"],
  ["134856", "NHL", "Dallas Stars", "Dallas", "TX", 32.7905, -96.8103, CT, "19860", "www.nhl.com/stars"],
  ["134832", "NHL", "Detroit Red Wings", "Detroit", "MI", 42.3411, -83.0553, ET, "24835", "www.nhl.com/redwings"],
  ["134849", "NHL", "Edmonton Oilers", "Edmonton", "AB", 53.5469, -113.4979, EDM, "27210", "www.nhl.com/oilers"],
  ["134833", "NHL", "Florida Panthers", "Sunrise", "FL", 26.1584, -80.3256, ET, "30646", "www.nhl.com/panthers"],
  ["134852", "NHL", "Los Angeles Kings", "Los Angeles", "CA", 34.043, -118.2673, PT, "25994", "www.nhl.com/kings"],
  ["134857", "NHL", "Minnesota Wild", "St. Paul", "MN", 44.9448, -93.101, CT, "25203", "www.nhl.com/wild"],
  ["134834", "NHL", "Montreal Canadiens", "Montreal", "QC", 45.4961, -73.5693, TOR, "24801", "www.nhl.com/canadiens"],
  ["134858", "NHL", "Nashville Predators", "Nashville", "TN", 36.1592, -86.7785, CT, "20104", "www.nhl.com/predators"],
  ["134840", "NHL", "New Jersey Devils", "Newark", "NJ", 40.7335, -74.1711, ET, "19332", "www.nhl.com/devils"],
  ["134841", "NHL", "New York Islanders", "Elmont", "NY", 40.7111, -73.7256, ET, "23194", "www.nhl.com/islanders"],
  ["134842", "NHL", "New York Rangers", "New York", "NY", 40.7505, -73.9934, ET, "16006", "www.nhl.com/rangers"],
  ["134835", "NHL", "Ottawa Senators", "Ottawa", "ON", 45.2969, -75.9272, TOR, "25207", "www.nhl.com/senators"],
  ["134843", "NHL", "Philadelphia Flyers", "Philadelphia", "PA", 39.9012, -75.172, ET, "19333", "www.nhl.com/flyers"],
  ["134844", "NHL", "Pittsburgh Penguins", "Pittsburgh", "PA", 40.4395, -79.9892, ET, "24831", "www.nhl.com/penguins"],
  ["134853", "NHL", "San Jose Sharks", "San Jose", "CA", 37.3327, -121.901, PT, "30661", "www.nhl.com/sharks"],
  ["140082", "NHL", "Seattle Kraken", "Seattle", "WA", 47.6221, -122.354, PT, "27140", "www.nhl.com/kraken"],
  ["134859", "NHL", "St. Louis Blues", "St. Louis", "MO", 38.6268, -90.2026, CT, "19866", "www.nhl.com/blues"],
  ["134836", "NHL", "Tampa Bay Lightning", "Tampa", "FL", 27.9428, -82.4519, ET, "20542", "www.nhl.com/lightning"],
  ["134837", "NHL", "Toronto Maple Leafs", "Toronto", "ON", 43.6435, -79.3791, TOR, "24830", "www.nhl.com/mapleleafs"],
  ["148494", "NHL", "Utah Mammoth", "Salt Lake City", "UT", 40.7683, -111.9011, MT, "29509", "www.nhl.com/utah"],
  ["134850", "NHL", "Vancouver Canucks", "Vancouver", "BC", 49.2778, -123.1088, VAN, "28400", "www.nhl.com/canucks"],
  ["135913", "NHL", "Vegas Golden Knights", "Las Vegas", "NV", 36.1029, -115.1784, PT, "16132", "www.nhl.com/goldenknights"],
  ["134845", "NHL", "Washington Capitals", "Washington", "DC", 38.8981, -77.0209, ET, "19331", "www.nhl.com/capitals"],
  ["134851", "NHL", "Winnipeg Jets", "Winnipeg", "MB", 49.8928, -97.1436, WPG, "28399", "www.nhl.com/jets"],
  // MLS
  ["135851", "MLS", "Atlanta United", "Atlanta", "GA", 33.7554, -84.4008, ET, "16029", "www.atlutd.com"],
  ["140079", "MLS", "Austin FC", "Austin", "TX", 30.3877, -97.7195, CT, "20821", "austinfc.com"],
  ["134150", "MLS", "CF Montréal", "Montreal", "QC", 45.5626, -73.5527, TOR, "18432", "www.cfmontreal.com"],
  ["140078", "MLS", "Charlotte FC", "Charlotte", "NC", 35.2258, -80.8528, ET, "18776", "charlottefootballclub.com"],
  ["134154", "MLS", "Chicago Fire", "Chicago", "IL", 41.8623, -87.6167, CT, "16092", "www.chicago-fire.com"],
  ["134794", "MLS", "Colorado Rapids", "Commerce City", "CO", 39.8056, -104.8919, MT, "18278", "www.coloradorapids.com"],
  ["134152", "MLS", "Columbus Crew", "Columbus", "OH", 39.9686, -83.0171, ET, "21135", "columbuscrew.com"],
  ["134145", "MLS", "DC United", "Washington", "DC", 38.8687, -77.0128, ET, "16774", "www.dcunited.com"],
  ["136688", "MLS", "FC Cincinnati", "Cincinnati", "OH", 39.111, -84.5221, ET, "20820", "www.fccincinnati.com"],
  ["134146", "MLS", "FC Dallas", "Frisco", "TX", 33.1544, -96.8353, CT, "16781", "www.fcdallas.com"],
  ["134144", "MLS", "Houston Dynamo", "Houston", "TX", 29.7522, -95.3524, CT, "27362", "www.houstondynamo.com"],
  ["137699", "MLS", "Inter Miami", "Miami", "FL", 25.79, -80.255, ET, "33736", "intermiamicf.com"],
  ["134153", "MLS", "LA Galaxy", "Carson", "CA", 33.8644, -118.2611, PT, "16785", "www.lagalaxy.com"],
  ["136050", "MLS", "Los Angeles FC", "Los Angeles", "CA", 34.0129, -118.2847, PT, "27515", "www.lafc.com"],
  ["135852", "MLS", "Minnesota United", "St. Paul", "MN", 44.953, -93.165, CT, "18236", "mnufc.com"],
  ["137700", "MLS", "Nashville SC", "Nashville", "TN", 36.1302, -86.7656, CT, "23849", "www.nashvillesc.com"],
  ["134159", "MLS", "New England Revolution", "Foxborough", "MA", 42.0909, -71.2643, ET, "15816", "www.revolutionsoccer.net"],
  ["134630", "MLS", "New York City FC", "Bronx", "NY", 40.8296, -73.9262, ET, "19474", "www.nycfc.com"],
  ["134156", "MLS", "New York Red Bulls", "Harrison", "NJ", 40.7368, -74.1503, ET, "15952", "www.newyorkredbulls.com"],
  ["135292", "MLS", "Orlando City", "Orlando", "FL", 28.5411, -81.3893, ET, "29997", "www.orlandocitysc.com"],
  ["134142", "MLS", "Philadelphia Union", "Chester", "PA", 39.8328, -75.3789, ET, "17527", "www.philadelphiaunion.com"],
  ["134155", "MLS", "Portland Timbers", "Portland", "OR", 45.5215, -122.6917, PT, "16779", "timbers.com"],
  ["134158", "MLS", "Real Salt Lake", "Sandy", "UT", 40.5829, -111.8933, MT, "16780", "www.realsaltlake.com"],
  ["150261", "MLS", "San Diego FC", "San Diego", "CA", 32.7831, -117.1196, PT, "24552", "www.sandiegofc.com"],
  ["134157", "MLS", "San Jose Earthquakes", "San Jose", "CA", 37.3513, -121.9253, PT, "20819", "www.sjearthquakes.com"],
  ["134149", "MLS", "Seattle Sounders", "Seattle", "WA", 47.5952, -122.3316, PT, "19833", "www.soundersfc.com"],
  ["134143", "MLS", "Sporting Kansas City", "Kansas City", "KS", 39.1218, -94.8231, CT, "18276", "www.sportingkc.com"],
  ["147062", "MLS", "St. Louis City SC", "St. Louis", "MO", 38.6312, -90.2108, CT, "27425", "www.stlcitysc.com"],
  ["134148", "MLS", "Toronto FC", "Toronto", "ON", 43.6332, -79.4186, TOR, "16782", "www.torontofc.ca"],
  ["134147", "MLS", "Vancouver Whitecaps", "Vancouver", "BC", 49.2768, -123.112, VAN, "25843", "www.whitecapsfc.com"],
];

const TEAMS: Team[] = ROWS.map(([id, league, name, city, state, lat, lng, tz, venueId, site]) => ({
  id,
  league,
  name,
  city,
  state,
  lat,
  lng,
  tz,
  venueId: venueId || undefined,
  site: site || undefined,
}));

const TEAM_BY_ID = new Map(TEAMS.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// Rate budget (shared through lib/kv; per-instance fallback when the store fails)
// ---------------------------------------------------------------------------

const localBudget = { window: -1, used: 0, coolUntil: 0 };

async function takeBudget(): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / (BUDGET_WINDOW_SECONDS * 1_000));
  try {
    if (await kvGet<number>("tsdb:cooldown")) return false;
    const used = await kvIncr(`tsdb:budget:${window}`, BUDGET_WINDOW_SECONDS * 2);
    return used <= BUDGET_CALLS_PER_WINDOW;
  } catch {
    if (now < localBudget.coolUntil) return false;
    if (localBudget.window !== window) {
      localBudget.window = window;
      localBudget.used = 0;
    }
    localBudget.used += 1;
    return localBudget.used <= BUDGET_CALLS_PER_WINDOW;
  }
}

async function coolDown(): Promise<void> {
  localBudget.coolUntil = Date.now() + COOLDOWN_SECONDS * 1_000;
  try {
    await kvSet("tsdb:cooldown", 1, COOLDOWN_SECONDS);
  } catch {
    // the local cool-down still applies
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

const FIELDS = [
  "idEvent",
  "strEvent",
  "strLeague",
  "idLeague",
  "idHomeTeam",
  "idAwayTeam",
  "strHomeTeam",
  "strAwayTeam",
  "strTimestamp",
  "dateEvent",
  "strTime",
  "idVenue",
  "strVenue",
  "strCountry",
  "strThumb",
  "strStatus",
  "strPostponed",
] as const;

/** The fields we keep from a TheSportsDB event (also the cached shape). */
type RawEvent = Partial<Record<(typeof FIELDS)[number], string>> & { idEvent: string };

function trimEvent(value: unknown): RawEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const field of FIELDS) {
    const x = v[field];
    if (typeof x === "string" && x.trim()) out[field] = x.trim().slice(0, 300);
    else if (typeof x === "number" && Number.isFinite(x)) out[field] = String(x);
  }
  return out.idEvent && /^\d{1,12}$/.test(out.idEvent) ? (out as RawEvent) : null;
}

function trimList(value: unknown): RawEvent[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(trimEvent).filter((e): e is RawEvent => e !== null);
}

/** One API call. [] = answered with no events; null = failed, rate-limited or over budget. */
async function fetchEvents(endpoint: "eventsnext.php" | "lookupevent.php", id: string): Promise<RawEvent[] | null> {
  if (!(await takeBudget())) return null;
  try {
    const res = await fetch(`${API_BASE}/${endpoint}?id=${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) {
      console.warn("[thesportsdb] rate limited — pausing calls");
      await coolDown();
      return null;
    }
    if (!res.ok) {
      console.warn(`[thesportsdb] HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { events?: unknown } | null;
    return trimList(data?.events) ?? [];
  } catch {
    console.warn("[thesportsdb] request failed");
    return null;
  }
}

/** A team's next game (free key: one event), cached; the 48-hour backup covers failures. */
async function teamGames(teamId: string): Promise<RawEvent[]> {
  const key = `tsdb:next:${teamId}`;
  try {
    const cached = trimList(await kvGet<unknown>(key));
    if (cached) return cached;
  } catch {
    // cache unavailable — continue live
  }
  const live = await fetchEvents("eventsnext.php", teamId);
  if (live) {
    try {
      await Promise.all([
        kvSet(key, live, live.length ? FRESH_TTL_SECONDS : EMPTY_TTL_SECONDS),
        kvSet(`${key}:stale`, live, STALE_TTL_SECONDS),
        ...live.map((e) => kvSet(`tsdb:event:${e.idEvent}`, e, EVENT_TTL_SECONDS)),
      ]);
    } catch {
      // ignore cache write failures
    }
    return live;
  }
  try {
    return trimList(await kvGet<unknown>(`${key}:stale`)) ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const NOT_STARTED = new Set(["", "ns", "not started", "tbd", "time to be defined", "scheduled"]);

/** Start time in epoch ms from strTimestamp (UTC), else dateEvent + strTime (UTC). */
function startMs(e: RawEvent): number | undefined {
  const raw = e.strTimestamp ?? (e.dateEvent && e.strTime ? `${e.dateEvent}T${e.strTime}` : undefined);
  if (!raw) return undefined;
  const iso = raw.replace(" ", "T");
  const ms = Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "YYYY-MM-DD" and "HH:MM" of an instant in a time zone. */
function localDateTime(ms: number, timeZone: string): { date: string; time: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const time = `${get("hour")}:${get("minute")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? { date, time } : undefined;
  } catch {
    return undefined;
  }
}

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!u.hostname.includes(".")) return undefined;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * A TheSportsDB event as a Livento event, or null when we can't place it reliably:
 * the home team must be one we know, and the game must be at that team's home venue
 * (neutral-site and international games would otherwise land in the wrong city).
 * `upcomingOnly` also drops games that started, finished, or have no start time.
 */
function mapGame(e: RawEvent, upcomingOnly: boolean, now = Date.now()): LiventoEvent | null {
  const team = e.idHomeTeam ? TEAM_BY_ID.get(e.idHomeTeam) : undefined;
  if (!team) return null;
  const status = (e.strStatus ?? "").toLowerCase();
  if (e.strPostponed?.toLowerCase() === "yes" || /canc|postpon|abandon|suspend|pst/.test(status)) return null;
  const country = CANADA.has(team.state) ? "Canada" : "United States";
  if (e.strCountry && e.strCountry !== country) return null;
  if (team.venueId && e.idVenue && e.idVenue !== team.venueId) return null;

  const ms = startMs(e);
  if (upcomingOnly && (ms === undefined || ms <= now || !NOT_STARTED.has(status))) return null;
  const local = ms === undefined ? undefined : localDateTime(ms, team.tz);
  const date = local?.date ?? (e.dateEvent && /^\d{4}-\d{2}-\d{2}$/.test(e.dateEvent) ? e.dateEvent : undefined);

  const home = e.strHomeTeam ?? team.name;
  const away = e.strAwayTeam ?? e.strEvent?.split(/\s+vs\.?\s+/i)[1]?.trim();
  const league = LEAGUES[team.league];
  const competition = e.idLeague === league.id || !e.strLeague ? team.league : e.strLeague;

  return {
    id: `tsdb_${e.idEvent}`,
    source: "thesportsdb",
    name: away ? `${away} at ${home}` : (e.strEvent ?? `${home} home game`),
    category: "sports",
    genre: league.sport,
    subGenre: competition,
    date,
    time: local?.time,
    venue: e.strVenue,
    city: team.city,
    state: team.state,
    lat: team.lat,
    lng: team.lng,
    priceNote: "Price not listed — check the team's official site",
    url: httpsUrl(team.site) ?? league.schedule,
    // No image: TheSportsDB thumbnails are composites of team and league logos, which DESIGN.md
    // rules out and TheSportsDB doesn't relicense. Cards fall back to the local sports photo.
    attribution: TSDB_ATTRIBUTION,
    tags: [
      ...new Set(
        ["sports", league.sport, team.league, competition, home, away]
          .filter((v): v is string => Boolean(v))
          .map((v) => v.toLowerCase()),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SportsQuery {
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  radiusMiles?: number;
  /** Earliest local game date (YYYY-MM-DD). Omit for "from now": start times are compared exactly. */
  from?: string;
  to: string; // YYYY-MM-DD, latest local game date
}

function nearTest(q: SportsQuery): (t: Team) => number | null {
  const radius = Math.min(500, Math.max(1, q.radiusMiles ?? DEFAULT_RADIUS_MILES));
  const origin: LatLng | undefined =
    typeof q.lat === "number" && typeof q.lng === "number" && isLatLng({ lat: q.lat, lng: q.lng })
      ? { lat: q.lat, lng: q.lng }
      : undefined;
  if (origin) {
    return (t) => {
      const d = distanceMiles(origin, t);
      return d <= radius ? d : null;
    };
  }
  const city = q.city?.trim().toLowerCase();
  const state = q.state?.trim().toUpperCase();
  return (t) => (city && t.city.toLowerCase() === city && (!state || t.state === state) ? 0 : null);
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Real upcoming games whose home venue is within the radius of the user's city
 * (or in the same city when there are no coordinates), soonest first. Never throws;
 * returns [] when nothing is known within the time cap.
 */
export async function getSportsEvents(q: SportsQuery): Promise<LiventoEvent[]> {
  const near = nearTest(q);
  const local = TEAMS.map((t) => ({ t, d: near(t) }))
    .filter((x): x is { t: Team; d: number } => x.d !== null)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_TEAMS_PER_QUERY);
  if (local.length === 0) return [];

  const work = (async () => {
    const lists = await Promise.all(local.map(({ t }) => teamGames(t.id)));
    const now = Date.now();
    const seen = new Set<string>();
    const out: LiventoEvent[] = [];
    for (const raw of lists.flat()) {
      if (seen.has(raw.idEvent)) continue;
      seen.add(raw.idEvent);
      const home = raw.idHomeTeam ? TEAM_BY_ID.get(raw.idHomeTeam) : undefined;
      if (!home || near(home) === null) continue; // away games elsewhere
      const event = mapGame(raw, true, now);
      if (!event?.date || (q.from && event.date < q.from) || event.date > q.to) continue;
      out.push(event);
    }
    return out.sort((a, b) => `${a.date} ${a.time ?? ""}`.localeCompare(`${b.date} ${b.time ?? ""}`));
  })();
  return withTimeout(work, OVERALL_TIMEOUT_MS, []);
}

/** TheSportsDB's event id from a Livento id ("tsdb_<idEvent>"), or null. */
export function sportsIdOf(liventoId: string): string | null {
  const m = /^tsdb_(\d{1,12})$/.exec(liventoId);
  return m ? m[1] : null;
}

/**
 * One game by TheSportsDB event id (lookupevent.php), cached 4 hours. Null when the
 * game is unknown, cancelled/postponed, not at a known home venue, or the call fails.
 */
export async function getSportsEventById(idEvent: string): Promise<LiventoEvent | null> {
  if (!/^\d{1,12}$/.test(idEvent)) return null;
  const key = `tsdb:event:${idEvent}`;
  try {
    const cached = await kvGet<unknown>(key);
    if (cached && typeof cached === "object" && "missing" in cached) return null;
    const hit = trimEvent(cached);
    if (hit) return mapGame(hit, false);
  } catch {
    // cache unavailable — continue live
  }
  const live = await fetchEvents("lookupevent.php", idEvent);
  if (!live) return null;
  const found = live.find((e) => e.idEvent === idEvent); // the free key can answer with a different event
  try {
    await kvSet(key, found ?? { missing: true }, found ? EVENT_TTL_SECONDS : MISSING_TTL_SECONDS);
  } catch {
    // ignore cache write failures
  }
  return found ? mapGame(found, false) : null;
}
