// Demo data: a made-up appliance repair site on example.com.
// Every case the scan knows about appears once, with live-check answers baked in
// so the demo never calls the network.

const S = "https://www.example.com";
const q = (query, path, impressions, position, clicks = 0) => ({ query, page: S + path, impressions, position, clicks });

const queryRows = [
  // 1. Real conflict: two live pages for the same city + service
  q("refrigerator repair tampa", "/refrigerator-repair-tampa-bay/", 310, 8.1, 4),
  q("refrigerator repair tampa", "/service-area/refrigerator-repair-in-tampa-fl/", 280, 8.9, 3),
  q("fridge repair tampa", "/refrigerator-repair-tampa-bay/", 120, 9.4, 1),
  q("fridge repair tampa", "/service-area/refrigerator-repair-in-tampa-fl/", 95, 10.2, 1),
  q("freezer repair tampa fl", "/refrigerator-repair-tampa-bay/", 70, 11.0),
  q("freezer repair tampa fl", "/service-area/refrigerator-repair-in-tampa-fl/", 64, 9.8),
  // 2. City hub outranking its own service page
  q("dryer repair austin", "/appliance-repair-austin-tx/", 140, 6.2, 2),
  q("dryer repair austin", "/services/dryer-repair-austin-tx/", 90, 21.5),
  q("dryer not heating repair austin tx", "/appliance-repair-austin-tx/", 60, 7.4),
  q("dryer not heating repair austin tx", "/services/dryer-repair-austin-tx/", 55, 18.0),
  // 3. Already fixed: the old page 301s to the new one, GSC still reports it
  q("washer repair orlando", "/washer-repair-orlando/", 180, 9.0, 2),
  q("washer repair orlando", "/service-area/washer-repair-in-orlando-fl/", 160, 7.5, 3),
  q("washing machine repair orlando", "/washer-repair-orlando/", 90, 10.1),
  q("washing machine repair orlando", "/service-area/washer-repair-in-orlando-fl/", 85, 8.2, 1),
  // 4. Fixed with a mistake: the old page was deleted (404) although it had clicks
  q("dishwasher repair miami", "/dishwasher-repair-miami/", 150, 7.9, 6),
  q("dishwasher repair miami", "/service-area/dishwasher-repair-in-miami-fl/", 120, 9.6, 2),
  q("dishwasher repair miami fl", "/dishwasher-repair-miami/", 60, 8.3, 1),
  q("dishwasher repair miami fl", "/service-area/dishwasher-repair-in-miami-fl/", 50, 10.4),
  // 5. Not a conflict: generic search, pages for different cities (Google localizes)
  q("ice maker repair", "/service-area/ice-maker-repair-dallas/", 400, 31.0),
  q("ice maker repair", "/service-area/ice-maker-repair-houston/", 380, 33.0),
  q("ice maker repair dallas", "/service-area/ice-maker-repair-dallas/", 220, 6.0, 3),
  q("ice maker repair houston", "/service-area/ice-maker-repair-houston/", 200, 5.5, 2),
  // 6. Brand searches are ignored
  q("examplefix reviews", "/service-area/ice-maker-repair-dallas/", 90, 2.0, 5),
  q("examplefix reviews", "/service-area/ice-maker-repair-houston/", 80, 2.1, 4),
];

const ok = (path) => ({ url: S + path, status: 200, finalUrl: S + path, finalStatus: 200, hops: 0, canonical: S + path, noindex: false });
const liveResults = [
  ok("/refrigerator-repair-tampa-bay/"),
  ok("/service-area/refrigerator-repair-in-tampa-fl/"),
  ok("/appliance-repair-austin-tx/"),
  ok("/services/dryer-repair-austin-tx/"),
  { url: S + "/washer-repair-orlando/", status: 301, finalUrl: S + "/service-area/washer-repair-in-orlando-fl/", finalStatus: 200, hops: 1, canonical: S + "/service-area/washer-repair-in-orlando-fl/", noindex: false },
  ok("/service-area/washer-repair-in-orlando-fl/"),
  { url: S + "/dishwasher-repair-miami/", status: 404, finalUrl: S + "/dishwasher-repair-miami/", finalStatus: 404, hops: 0, canonical: null, noindex: false },
  ok("/service-area/dishwasher-repair-in-miami-fl/"),
  ok("/service-area/ice-maker-repair-dallas/"),
  ok("/service-area/ice-maker-repair-houston/"),
];

export const DEMO = { queryRows, liveResults, brands: ["examplefix"], site: "www.example.com" };
