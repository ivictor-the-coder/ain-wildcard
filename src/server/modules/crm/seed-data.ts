/**
 * Northwind Robotics sells a usage-priced telemetry platform to factories:
 * an edge agent on every robot, CNC cell and PLC, streaming health and cycle
 * data into a cloud that bills per connected asset per month.
 *
 * This is their book of business. Every account below is a plausible customer
 * for that product, with the firmographics, controls stack and buying committee
 * an industrial rep would actually record.
 */

export type NameStyle =
  | 'us' | 'de' | 'fr' | 'nordic' | 'nl' | 'it' | 'iberian' | 'pl' | 'tr'
  | 'jp' | 'kr' | 'in' | 'cn' | 'br';

export interface CompanySeed {
  slug: string;
  name: string;
  domain: string;
  industry: string;
  employees: number;
  /** Annual revenue in whole US dollars; converted to cents on insert. */
  revenue: number;
  street: string;
  city: string;
  state: string;
  postal: string;
  country: string;
  region: 'north_america' | 'emea' | 'apac' | 'latam';
  plants: number;
  assets: number;
  maturity: string;
  platforms: string[];
  lifecycle: string;
  type: string;
  source: string;
  sourceDetail: string;
  founded: number;
  key: boolean;
  tier: string;
  owner: number;
  createdDaysAgo: number;
  names: NameStyle;
  description: string;
}

export const COMPANIES: CompanySeed[] = [
  { slug: 'meridianforge', name: 'Meridian Forge Systems', domain: 'meridianforge.com', industry: 'metals', employees: 4200, revenue: 1_180_000_000,
    street: '4100 Chagrin River Road', city: 'Cleveland', state: 'Ohio', postal: '44113', country: 'United States', region: 'north_america',
    plants: 7, assets: 612, maturity: 'plant_wide', platforms: ['rockwell', 'fanuc'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'IMTS Chicago 2024 — booth 338', founded: 1948, key: true, tier: 'mission_critical', owner: 1, createdDaysAgo: 512, names: 'us',
    description: 'Forging and heat-treatment for heavy truck and rail. Seven plants across the Midwest running 24/5 with a 40-year-old asset base and an aggressive uptime programme.' },
  { slug: 'caldervance', name: 'Calder & Vance Manufacturing', domain: 'caldervance.com', industry: 'contract_mfg', employees: 1800, revenue: 410_000_000,
    street: '2200 Leonard Street NW', city: 'Grand Rapids', state: 'Michigan', postal: '49504', country: 'United States', region: 'north_america',
    plants: 3, assets: 214, maturity: 'multi_line', platforms: ['rockwell', 'universal_robots'], lifecycle: 'customer', type: 'customer',
    source: 'partner_referral', sourceDetail: 'Referred by Sableworks Robotics', founded: 1972, key: false, tier: 'premium', owner: 2, createdDaysAgo: 468, names: 'us',
    description: 'Tier-two contract manufacturer for office furniture and appliance OEMs. Won a large appliance programme in 2024 and is adding two cobot cells a quarter.' },
  { slug: 'halstead', name: 'Halstead Precision Works', domain: 'halsteadprecision.com', industry: 'aerospace', employees: 950, revenue: 268_000_000,
    street: '1815 South Oliver Street', city: 'Wichita', state: 'Kansas', postal: '67210', country: 'United States', region: 'north_america',
    plants: 2, assets: 96, maturity: 'multi_line', platforms: ['siemens', 'fanuc'], lifecycle: 'customer', type: 'customer',
    source: 'inbound_content', sourceDetail: 'Downloaded "Spindle health for AS9100 shops"', founded: 1961, key: false, tier: 'premium', owner: 2, createdDaysAgo: 402, names: 'us',
    description: 'Five-axis machining of structural aerospace components. AS9100D certified; every spindle hour is traceable to a serialised part.' },
  { slug: 'brightline', name: 'Brightline Foods', domain: 'brightlinefoods.com', industry: 'food_beverage', employees: 6400, revenue: 2_240_000_000,
    street: '900 Locust Street', city: 'Des Moines', state: 'Iowa', postal: '50309', country: 'United States', region: 'north_america',
    plants: 11, assets: 848, maturity: 'enterprise', platforms: ['rockwell', 'siemens', 'abb'], lifecycle: 'customer', type: 'customer',
    source: 'outbound_sequence', sourceDetail: 'Q3 plant-manager sequence, step 4', founded: 1935, key: true, tier: 'mission_critical', owner: 1, createdDaysAgo: 540, names: 'us',
    description: 'Ready-meal and snack manufacturer supplying national grocery. Eleven plants, heavy palletising and case-packing automation, brutal changeover schedules.' },
  { slug: 'kestrel', name: 'Kestrel Aerospace Components', domain: 'kestrelaero.com', industry: 'aerospace', employees: 2300, revenue: 690_000_000,
    street: '3400 Airport Road', city: 'Everett', state: 'Washington', postal: '98204', country: 'United States', region: 'north_america',
    plants: 4, assets: 302, maturity: 'plant_wide', platforms: ['siemens', 'kuka'], lifecycle: 'customer', type: 'customer',
    source: 'customer_referral', sourceDetail: 'Introduced by Halstead Precision', founded: 1988, key: true, tier: 'premium', owner: 3, createdDaysAgo: 386, names: 'us',
    description: 'Composite and metallic sub-assemblies for commercial airframes. Rate increases from their primes are forcing a step change in cell utilisation.' },
  { slug: 'ironwood', name: 'Ironwood Packaging Group', domain: 'ironwoodpackaging.com', industry: 'packaging', employees: 3100, revenue: 745_000_000,
    street: '1750 Mill Street', city: 'Green Bay', state: 'Wisconsin', postal: '54303', country: 'United States', region: 'north_america',
    plants: 6, assets: 418, maturity: 'plant_wide', platforms: ['rockwell', 'omron'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'Pack Expo 2023', founded: 1954, key: false, tier: 'premium', owner: 3, createdDaysAgo: 498, names: 'us',
    description: 'Corrugated and folding-carton converter. Runs 6 plants of high-speed converting lines where a jam costs $4,000 a minute.' },
  { slug: 'pemberton', name: 'Pemberton Auto Systems', domain: 'pembertonauto.com', industry: 'automotive', employees: 12800, revenue: 4_600_000_000,
    street: '18000 Mound Road', city: 'Detroit', state: 'Michigan', postal: '48234', country: 'United States', region: 'north_america',
    plants: 14, assets: 1960, maturity: 'enterprise', platforms: ['rockwell', 'fanuc', 'abb'], lifecycle: 'opportunity', type: 'prospect',
    source: 'field_event', sourceDetail: 'Detroit automation roundtable, March', founded: 1919, key: true, tier: 'mission_critical', owner: 1, createdDaysAgo: 214, names: 'us',
    description: 'Tier-one supplier of seating and interior systems to the Detroit three. Running a global MES consolidation; telemetry is the layer underneath it.' },
  { slug: 'aldergate', name: 'Aldergate Semiconductor', domain: 'aldergatesemi.com', industry: 'semiconductors', employees: 5400, revenue: 2_900_000_000,
    street: '2400 West Chandler Boulevard', city: 'Chandler', state: 'Arizona', postal: '85224', country: 'United States', region: 'north_america',
    plants: 3, assets: 1140, maturity: 'enterprise', platforms: ['beckhoff', 'omron'], lifecycle: 'opportunity', type: 'prospect',
    source: 'inbound_content', sourceDetail: 'Requested the fab-tooling benchmark report', founded: 2001, key: true, tier: 'mission_critical', owner: 2, createdDaysAgo: 176, names: 'us',
    description: 'Analogue and power semiconductor fabs. Tool downtime is measured in wafers, not minutes, and their internal SPC team is unusually sophisticated.' },
  { slug: 'northgatechem', name: 'Northgate Chemical Works', domain: 'northgatechem.com', industry: 'chemicals', employees: 2700, revenue: 1_050_000_000,
    street: '6100 Scenic Highway', city: 'Baton Rouge', state: 'Louisiana', postal: '70805', country: 'United States', region: 'north_america',
    plants: 4, assets: 226, maturity: 'multi_line', platforms: ['siemens', 'rockwell'], lifecycle: 'customer', type: 'customer',
    source: 'outbound_sequence', sourceDetail: 'Reliability-manager sequence', founded: 1966, key: false, tier: 'standard', owner: 3, createdDaysAgo: 356, names: 'us',
    description: 'Specialty intermediates for coatings and adhesives. Continuous process with rotating equipment that has to be monitored, not scheduled.' },
  { slug: 'cascademed', name: 'Cascade Medical Devices', domain: 'cascademeddev.com', industry: 'medical_devices', employees: 1400, revenue: 520_000_000,
    street: '9500 Southwest Nimbus Avenue', city: 'Beaverton', state: 'Oregon', postal: '97008', country: 'United States', region: 'north_america',
    plants: 2, assets: 148, maturity: 'multi_line', platforms: ['beckhoff', 'universal_robots'], lifecycle: 'customer', type: 'customer',
    source: 'webinar', sourceDetail: 'Validated telemetry for FDA 21 CFR Part 11', founded: 1994, key: false, tier: 'premium', owner: 4, createdDaysAgo: 322, names: 'us',
    description: 'Single-use surgical instruments in cleanroom assembly. Every data change has to be attributable and audit-ready.' },
  { slug: 'quarryridge', name: 'Quarry Ridge Building Products', domain: 'quarryridge.com', industry: 'building_products', employees: 890, revenue: 214_000_000,
    street: '3300 Lebanon Pike', city: 'Nashville', state: 'Tennessee', postal: '37214', country: 'United States', region: 'north_america',
    plants: 3, assets: 74, maturity: 'single_line', platforms: ['rockwell'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'paid_search', sourceDetail: 'Search: "predictive maintenance for kilns"', founded: 1979, key: false, tier: 'standard', owner: 3, createdDaysAgo: 128, names: 'us',
    description: 'Engineered stone and cladding. A single kiln line drives most of the plant P&L, and it has failed twice this year.' },
  { slug: 'sableworks', name: 'Sableworks Robotics', domain: 'sableworks.com', industry: 'contract_mfg', employees: 320, revenue: 78_000_000,
    street: '11500 Burnet Road', city: 'Austin', state: 'Texas', postal: '78758', country: 'United States', region: 'north_america',
    plants: 1, assets: 58, maturity: 'multi_line', platforms: ['universal_robots', 'fanuc'], lifecycle: 'customer', type: 'partner',
    source: 'partner_referral', sourceDetail: 'Systems-integrator partner programme', founded: 2014, key: false, tier: 'premium', owner: 4, createdDaysAgo: 430, names: 'us',
    description: 'Systems integrator that deploys cobot cells for mid-market manufacturers. Resells Northwind telemetry with every cell they commission.' },
  { slug: 'thornbury', name: 'Thornbury Logistics', domain: 'thornburylogistics.com', industry: 'logistics', employees: 8900, revenue: 1_960_000_000,
    street: '3200 Democrat Road', city: 'Memphis', state: 'Tennessee', postal: '38118', country: 'United States', region: 'north_america',
    plants: 9, assets: 1320, maturity: 'plant_wide', platforms: ['siemens', 'kuka', 'omron'], lifecycle: 'opportunity', type: 'prospect',
    source: 'trade_show', sourceDetail: 'MODEX 2025', founded: 1983, key: true, tier: 'premium', owner: 1, createdDaysAgo: 152, names: 'us',
    description: 'Third-party logistics with nine automated distribution centres. Sortation and AS/RS uptime is contractual — SLAs with penalties.' },
  { slug: 'fairhaven', name: 'Fairhaven Dairy Co-operative', domain: 'fairhavendairy.com', industry: 'food_beverage', employees: 2100, revenue: 780_000_000,
    street: '1200 Jefferson Road', city: 'Rochester', state: 'New York', postal: '14623', country: 'United States', region: 'north_america',
    plants: 5, assets: 264, maturity: 'multi_line', platforms: ['rockwell', 'abb'], lifecycle: 'customer', type: 'customer',
    source: 'customer_referral', sourceDetail: 'Referred by Brightline Foods', founded: 1922, key: false, tier: 'standard', owner: 4, createdDaysAgo: 288, names: 'us',
    description: 'Farmer-owned dairy co-op. Filling and capping lines with CIP cycles that make maintenance windows scarce.' },
  { slug: 'redstone', name: 'Redstone Energy Services', domain: 'redstoneenergy.com', industry: 'energy', employees: 4600, revenue: 1_640_000_000,
    street: '5100 Westheimer Road', city: 'Houston', state: 'Texas', postal: '77056', country: 'United States', region: 'north_america',
    plants: 6, assets: 396, maturity: 'multi_line', platforms: ['siemens', 'rockwell'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'outbound_sequence', sourceDetail: 'Reliability leaders sequence, step 2', founded: 1998, key: false, tier: 'standard', owner: 2, createdDaysAgo: 96, names: 'us',
    description: 'Fabrication and service for upstream energy. Remote yards where a technician visit costs more than the sensor.' },
  { slug: 'lakeshore', name: 'Lakeshore Plastics', domain: 'lakeshoreplastics.com', industry: 'packaging', employees: 620, revenue: 142_000_000,
    street: '2020 East Lake Road', city: 'Erie', state: 'Pennsylvania', postal: '16511', country: 'United States', region: 'north_america',
    plants: 2, assets: 62, maturity: 'single_line', platforms: ['omron'], lifecycle: 'marketing_qualified_lead', type: 'prospect',
    source: 'inbound_content', sourceDetail: 'Injection-moulding OEE calculator', founded: 1987, key: false, tier: 'standard', owner: 3, createdDaysAgo: 74, names: 'us',
    description: 'Injection moulding for consumer and industrial parts. Forty presses, one maintenance planner, no historian.' },
  { slug: 'granitepeak', name: 'Granite Peak Mining Equipment', domain: 'granitepeakequip.com', industry: 'metals', employees: 1750, revenue: 495_000_000,
    street: '4400 West 2100 South', city: 'Salt Lake City', state: 'Utah', postal: '84120', country: 'United States', region: 'north_america',
    plants: 3, assets: 132, maturity: 'multi_line', platforms: ['rockwell', 'abb'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'MINExpo 2024', founded: 1969, key: false, tier: 'standard', owner: 3, createdDaysAgo: 344, names: 'us',
    description: 'Heavy fabrication for mining and quarry equipment. Weld cells and plasma tables that run hot for eleven months a year.' },
  { slug: 'portagebrands', name: 'Portage CPG Brands', domain: 'portagebrands.com', industry: 'cpg', employees: 3400, revenue: 1_120_000_000,
    street: '700 Washington Avenue North', city: 'Minneapolis', state: 'Minnesota', postal: '55401', country: 'United States', region: 'north_america',
    plants: 5, assets: 288, maturity: 'plant_wide', platforms: ['rockwell', 'siemens'], lifecycle: 'customer', type: 'customer',
    source: 'webinar', sourceDetail: 'Line-changeover benchmarking webinar', founded: 1991, key: false, tier: 'premium', owner: 4, createdDaysAgo: 268, names: 'us',
    description: 'House of household-care and personal-care brands. Constant SKU proliferation means constant changeovers.' },
  { slug: 'wexler', name: 'Wexler Pharmaceutical', domain: 'wexlerpharma.com', industry: 'pharma', employees: 5100, revenue: 2_380_000_000,
    street: '3000 Kit Creek Road', city: 'Morrisville', state: 'North Carolina', postal: '27560', country: 'United States', region: 'north_america',
    plants: 4, assets: 520, maturity: 'plant_wide', platforms: ['siemens', 'beckhoff'], lifecycle: 'opportunity', type: 'prospect',
    source: 'field_event', sourceDetail: 'ISPE Carolina chapter dinner', founded: 1977, key: true, tier: 'mission_critical', owner: 2, createdDaysAgo: 188, names: 'us',
    description: 'Sterile injectables and oral solids. GxP everywhere; the validation burden is the real evaluation criterion.' },
  { slug: 'cobaltline', name: 'Cobalt Line Automation', domain: 'cobaltline.com', industry: 'contract_mfg', employees: 210, revenue: 46_000_000,
    street: '295 Hagey Boulevard', city: 'Waterloo', state: 'Ontario', postal: 'N2L 6R5', country: 'Canada', region: 'north_america',
    plants: 1, assets: 34, maturity: 'multi_line', platforms: ['beckhoff', 'universal_robots'], lifecycle: 'customer', type: 'reseller',
    source: 'partner_referral', sourceDetail: 'Canadian integrator programme', founded: 2011, key: false, tier: 'standard', owner: 4, createdDaysAgo: 246, names: 'us',
    description: 'Machine builder for battery and electronics assembly. Bundles Northwind telemetry into every machine they ship.' },

  { slug: 'rheinwerk', name: 'Rheinwerk Antriebstechnik', domain: 'rheinwerk.de', industry: 'automotive', employees: 7200, revenue: 2_640_000_000,
    street: 'Industriestraße 44', city: 'Stuttgart', state: 'Baden-Württemberg', postal: '70565', country: 'Germany', region: 'emea',
    plants: 8, assets: 1080, maturity: 'enterprise', platforms: ['siemens', 'kuka'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'Hannover Messe 2024', founded: 1926, key: true, tier: 'mission_critical', owner: 2, createdDaysAgo: 476, names: 'de',
    description: 'Drivetrain components for German OEMs. Eight plants, an in-house MES team, and a works council that must approve any new data collection.' },
  { slug: 'vastero', name: 'Västerö Industriteknik', domain: 'vastero.se', industry: 'metals', employees: 1350, revenue: 386_000_000,
    street: 'Hamngatan 18', city: 'Gothenburg', state: 'Västra Götaland', postal: '411 06', country: 'Sweden', region: 'emea',
    plants: 3, assets: 158, maturity: 'multi_line', platforms: ['abb', 'siemens'], lifecycle: 'customer', type: 'customer',
    source: 'inbound_content', sourceDetail: 'Nordic manufacturing energy report', founded: 1954, key: false, tier: 'premium', owner: 3, createdDaysAgo: 398, names: 'nordic',
    description: 'Precision steel components for marine and offshore. Energy cost per tonne is a board-level metric.' },
  { slug: 'ardennes', name: 'Ardennes Précision', domain: 'ardennes-precision.fr', industry: 'aerospace', employees: 2450, revenue: 712_000_000,
    street: "12 rue de l'Industrie", city: 'Toulouse', state: 'Occitanie', postal: '31200', country: 'France', region: 'emea',
    plants: 4, assets: 286, maturity: 'plant_wide', platforms: ['siemens', 'fanuc'], lifecycle: 'customer', type: 'customer',
    source: 'partner_referral', sourceDetail: 'Referred by their systems integrator in Lyon', founded: 1963, key: true, tier: 'premium', owner: 3, createdDaysAgo: 364, names: 'fr',
    description: 'Machining and treatment for civil aerospace. Rate ramp from Airbus is the entire strategic context.' },
  { slug: 'vandoorn', name: 'Van Doorn Verpakking', domain: 'vandoorn.nl', industry: 'packaging', employees: 980, revenue: 262_000_000,
    street: 'De Run 4302', city: 'Eindhoven', state: 'Noord-Brabant', postal: '5503 LN', country: 'Netherlands', region: 'emea',
    plants: 2, assets: 118, maturity: 'multi_line', platforms: ['beckhoff', 'omron'], lifecycle: 'customer', type: 'customer',
    source: 'webinar', sourceDetail: 'OEE for high-speed converting', founded: 1981, key: false, tier: 'standard', owner: 4, createdDaysAgo: 306, names: 'nl',
    description: 'Flexible packaging converter supplying food brands across the Benelux. Fast lines, thin margins, obsessive about waste.' },
  { slug: 'kilbride', name: 'Kilbride Dairy Systems', domain: 'kilbride.ie', industry: 'food_beverage', employees: 740, revenue: 198_000_000,
    street: 'Little Island Business Park', city: 'Cork', state: 'Munster', postal: 'T45 KX88', country: 'Ireland', region: 'emea',
    plants: 2, assets: 88, maturity: 'single_line', platforms: ['siemens'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'inbound_content', sourceDetail: 'CIP cycle optimisation guide', founded: 1975, key: false, tier: 'standard', owner: 3, createdDaysAgo: 112, names: 'us',
    description: 'Dairy processing equipment and contract filling. Seasonal peak means the plant cannot stop between May and September.' },
  { slug: 'ferrante', name: 'Ferrante Meccanica', domain: 'ferrantemeccanica.it', industry: 'contract_mfg', employees: 1650, revenue: 428_000_000,
    street: 'Via Cassala 128', city: 'Brescia', state: 'Lombardia', postal: '25126', country: 'Italy', region: 'emea',
    plants: 3, assets: 192, maturity: 'multi_line', platforms: ['siemens', 'fanuc', 'universal_robots'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'EMO Milano', founded: 1958, key: false, tier: 'premium', owner: 2, createdDaysAgo: 334, names: 'it',
    description: 'Machining and assembly for hydraulics and agricultural equipment. Family-owned, third generation, quietly excellent at lean.' },
  { slug: 'norbjerg', name: 'Norbjerg Vindkraft', domain: 'norbjerg.dk', industry: 'energy', employees: 3800, revenue: 1_420_000_000,
    street: 'Havnegade 31', city: 'Aarhus', state: 'Midtjylland', postal: '8000', country: 'Denmark', region: 'emea',
    plants: 5, assets: 412, maturity: 'plant_wide', platforms: ['siemens', 'abb', 'kuka'], lifecycle: 'opportunity', type: 'prospect',
    source: 'field_event', sourceDetail: 'Copenhagen wind supply-chain summit', founded: 1992, key: true, tier: 'premium', owner: 1, createdDaysAgo: 164, names: 'nordic',
    description: 'Nacelle and blade component manufacturing for offshore wind. Enormous parts, long cycles, and a serious appetite for predictive maintenance.' },
  { slug: 'castellon', name: 'Castellón Cerámica Industrial', domain: 'castellonceramica.es', industry: 'building_products', employees: 1200, revenue: 268_000_000,
    street: 'Carretera Alcora 42', city: 'Castellón de la Plana', state: 'Comunidad Valenciana', postal: '12006', country: 'Spain', region: 'emea',
    plants: 3, assets: 104, maturity: 'single_line', platforms: ['siemens', 'omron'], lifecycle: 'marketing_qualified_lead', type: 'prospect',
    source: 'paid_search', sourceDetail: 'Search: "monitorización de hornos industriales"', founded: 1984, key: false, tier: 'standard', owner: 3, createdDaysAgo: 88, names: 'iberian',
    description: 'Ceramic tile manufacturer. Kiln energy is 38% of cost of goods, so thermal drift detection sells itself.' },
  { slug: 'whitcombe', name: 'Whitcombe Aerospace', domain: 'whitcombe.co.uk', industry: 'aerospace', employees: 4300, revenue: 1_380_000_000,
    street: 'Aztec West Business Park', city: 'Bristol', state: 'England', postal: 'BS32 4AQ', country: 'United Kingdom', region: 'emea',
    plants: 5, assets: 468, maturity: 'plant_wide', platforms: ['siemens', 'kuka', 'fanuc'], lifecycle: 'customer', type: 'customer',
    source: 'customer_referral', sourceDetail: 'Referred by Ardennes Précision', founded: 1937, key: true, tier: 'mission_critical', owner: 2, createdDaysAgo: 452, names: 'us',
    description: 'Landing gear and actuation systems. Deep supplier obligations mean traceability is not optional at any point in the process.' },
  { slug: 'zielinski', name: 'Zieliński Chemia', domain: 'zielinskichemia.pl', industry: 'chemicals', employees: 2900, revenue: 690_000_000,
    street: 'ulica Fabryczna 17', city: 'Wrocław', state: 'Dolnośląskie', postal: '53-609', country: 'Poland', region: 'emea',
    plants: 4, assets: 176, maturity: 'multi_line', platforms: ['siemens', 'rockwell'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'outbound_sequence', sourceDetail: 'CEE manufacturing sequence', founded: 1971, key: false, tier: 'standard', owner: 3, createdDaysAgo: 134, names: 'pl',
    description: 'Industrial coatings and resins. Growing fast on the back of German automotive nearshoring.' },
  { slug: 'helvetia', name: 'Helvetia Feinmechanik', domain: 'helvetia-feinmechanik.ch', industry: 'medical_devices', employees: 560, revenue: 214_000_000,
    street: 'Zürcherstrasse 88', city: 'Winterthur', state: 'Zürich', postal: '8400', country: 'Switzerland', region: 'emea',
    plants: 1, assets: 72, maturity: 'multi_line', platforms: ['beckhoff', 'universal_robots'], lifecycle: 'customer', type: 'customer',
    source: 'inbound_content', sourceDetail: 'Micro-machining tolerance drift paper', founded: 1948, key: false, tier: 'premium', owner: 4, createdDaysAgo: 292, names: 'de',
    description: 'Micro-components for implantables and surgical robotics. Tolerances measured in single-digit microns.' },
  { slug: 'marmara', name: 'Marmara Otomotiv', domain: 'marmaraotomotiv.com.tr', industry: 'automotive', employees: 9600, revenue: 2_180_000_000,
    street: 'Organize Sanayi Bölgesi 4. Cadde', city: 'Bursa', state: 'Marmara', postal: '16140', country: 'Türkiye', region: 'emea',
    plants: 7, assets: 1240, maturity: 'plant_wide', platforms: ['siemens', 'abb', 'fanuc'], lifecycle: 'opportunity', type: 'prospect',
    source: 'trade_show', sourceDetail: 'Automechanika Istanbul', founded: 1974, key: false, tier: 'premium', owner: 2, createdDaysAgo: 142, names: 'tr',
    description: 'Body-in-white and stamping for European OEM programmes. Cost-per-part discipline is ferocious.' },
  { slug: 'kaskade', name: 'Kaskade Pharma Group', domain: 'kaskadepharma.de', industry: 'pharma', employees: 6800, revenue: 3_240_000_000,
    street: 'Kaiser-Wilhelm-Allee 60', city: 'Leverkusen', state: 'Nordrhein-Westfalen', postal: '51373', country: 'Germany', region: 'emea',
    plants: 6, assets: 704, maturity: 'plant_wide', platforms: ['siemens', 'beckhoff'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'webinar', sourceDetail: 'GAMP 5 second edition and continuous data', founded: 1953, key: true, tier: 'mission_critical', owner: 1, createdDaysAgo: 118, names: 'de',
    description: 'Generics and biosimilars at scale. Every system touches validated processes, so the qualification plan is the sale.' },
  { slug: 'oranmore', name: 'Oranmore Logistics', domain: 'oranmore.ie', industry: 'logistics', employees: 1500, revenue: 342_000_000,
    street: 'Northwest Business Park', city: 'Dublin', state: 'Leinster', postal: 'D15 XW60', country: 'Ireland', region: 'emea',
    plants: 3, assets: 210, maturity: 'multi_line', platforms: ['omron', 'kuka'], lifecycle: 'lead', type: 'prospect',
    source: 'paid_search', sourceDetail: 'Search: "conveyor predictive maintenance"', founded: 2003, key: false, tier: 'standard', owner: 3, createdDaysAgo: 46, names: 'us',
    description: 'Cold-chain and pharma distribution across Ireland and the UK. Automation added fast during 2021; instrumentation never caught up.' },

  { slug: 'sakamoto', name: 'Sakamoto Seiki', domain: 'sakamotoseiki.jp', industry: 'semiconductors', employees: 3300, revenue: 1_480_000_000,
    street: '2-14-1 Ozu', city: 'Kumamoto', state: 'Kumamoto', postal: '861-2202', country: 'Japan', region: 'apac',
    plants: 3, assets: 596, maturity: 'enterprise', platforms: ['mitsubishi', 'omron', 'fanuc'], lifecycle: 'customer', type: 'customer',
    source: 'partner_referral', sourceDetail: 'Introduced by their Tokyo distributor', founded: 1969, key: true, tier: 'mission_critical', owner: 2, createdDaysAgo: 424, names: 'jp',
    description: 'Precision tooling and back-end equipment for semiconductor packaging. Kaizen culture; they will out-measure you.' },
  { slug: 'hanwoo', name: 'Hanwoo Precision', domain: 'hanwooprecision.kr', industry: 'automotive', employees: 5700, revenue: 1_920_000_000,
    street: '145 Yeompo-ro, Buk-gu', city: 'Ulsan', state: 'Ulsan', postal: '44248', country: 'South Korea', region: 'apac',
    plants: 5, assets: 780, maturity: 'plant_wide', platforms: ['mitsubishi', 'fanuc', 'abb'], lifecycle: 'customer', type: 'customer',
    source: 'trade_show', sourceDetail: 'Automation World Seoul', founded: 1988, key: false, tier: 'premium', owner: 3, createdDaysAgo: 372, names: 'kr',
    description: 'Powertrain and EV component machining. Moving from combustion to battery housings, which changed every cycle time they had.' },
  { slug: 'bendigo', name: 'Bendigo Mining Systems', domain: 'bendigomining.com.au', industry: 'metals', employees: 2200, revenue: 618_000_000,
    street: '42 Sheffield Road', city: 'Perth', state: 'Western Australia', postal: '6104', country: 'Australia', region: 'apac',
    plants: 3, assets: 168, maturity: 'multi_line', platforms: ['rockwell', 'abb'], lifecycle: 'opportunity', type: 'prospect',
    source: 'outbound_sequence', sourceDetail: 'APAC mining sequence, step 3', founded: 1990, key: false, tier: 'standard', owner: 2, createdDaysAgo: 158, names: 'us',
    description: 'Fabrication and refurbishment for mining fleets. Sites are remote enough that a truck roll is a two-day commitment.' },
  { slug: 'selangor', name: 'Selangor Circuit Works', domain: 'selangorcircuit.my', industry: 'semiconductors', employees: 4100, revenue: 1_240_000_000,
    street: 'Jalan Hi-Tech 4, Kulim', city: 'Penang', state: 'Penang', postal: '11900', country: 'Malaysia', region: 'apac',
    plants: 2, assets: 640, maturity: 'plant_wide', platforms: ['omron', 'mitsubishi'], lifecycle: 'customer', type: 'customer',
    source: 'inbound_content', sourceDetail: 'SMT line utilisation benchmark', founded: 1996, key: false, tier: 'premium', owner: 4, createdDaysAgo: 316, names: 'us',
    description: 'PCB assembly and test for automotive and industrial electronics. Sixty SMT lines running three shifts.' },
  { slug: 'tanakafoods', name: 'Tanaka Foods Industrial', domain: 'tanakafoods.jp', industry: 'food_beverage', employees: 2600, revenue: 880_000_000,
    street: '3-5-12 Fukushima, Fukushima-ku', city: 'Osaka', state: 'Osaka', postal: '553-0003', country: 'Japan', region: 'apac',
    plants: 4, assets: 232, maturity: 'multi_line', platforms: ['mitsubishi', 'omron'], lifecycle: 'sales_qualified_lead', type: 'prospect',
    source: 'field_event', sourceDetail: 'Osaka food-manufacturing forum', founded: 1951, key: false, tier: 'standard', owner: 3, createdDaysAgo: 106, names: 'jp',
    description: 'Prepared foods and sauces for convenience retail. Extremely high SKU count with tight sanitation cycles.' },
  { slug: 'gangesvalley', name: 'Ganges Valley Pharma', domain: 'gangesvalleypharma.in', industry: 'pharma', employees: 7400, revenue: 1_680_000_000,
    street: 'Plot 24, Genome Valley', city: 'Hyderabad', state: 'Telangana', postal: '500078', country: 'India', region: 'apac',
    plants: 6, assets: 486, maturity: 'multi_line', platforms: ['siemens', 'rockwell'], lifecycle: 'opportunity', type: 'prospect',
    source: 'webinar', sourceDetail: 'Data integrity for USFDA inspections', founded: 1994, key: false, tier: 'premium', owner: 2, createdDaysAgo: 172, names: 'in',
    description: 'Contract manufacturer of oral solids for export markets. USFDA inspection readiness drives every technology decision.' },
  { slug: 'kaiping', name: 'Kaiping Motion Control', domain: 'kaipingmotion.cn', industry: 'contract_mfg', employees: 11200, revenue: 2_460_000_000,
    street: '188 Kefa Road, Nanshan', city: 'Shenzhen', state: 'Guangdong', postal: '518057', country: 'China', region: 'apac',
    plants: 9, assets: 1580, maturity: 'plant_wide', platforms: ['mitsubishi', 'omron', 'kuka'], lifecycle: 'lead', type: 'prospect',
    source: 'trade_show', sourceDetail: 'Industrial Automation Show Shanghai', founded: 1999, key: false, tier: 'standard', owner: 3, createdDaysAgo: 62, names: 'cn',
    description: 'Motion components and sub-assemblies at volume. Nine plants and an internal platform team that will build if we do not win on time-to-value.' },

  { slug: 'aconcagua', name: 'Aconcagua Alimentos', domain: 'aconcaguaalimentos.com.ar', industry: 'food_beverage', employees: 3900, revenue: 742_000_000,
    street: 'Ruta Provincial 60 km 12', city: 'Mendoza', state: 'Mendoza', postal: 'M5507', country: 'Argentina', region: 'latam',
    plants: 5, assets: 246, maturity: 'multi_line', platforms: ['rockwell', 'siemens'], lifecycle: 'customer', type: 'customer',
    source: 'partner_referral', sourceDetail: 'Referred by regional integrator', founded: 1967, key: false, tier: 'standard', owner: 4, createdDaysAgo: 278, names: 'iberian',
    description: 'Fruit processing and wine bottling. Harvest windows make unplanned downtime existentially expensive.' },
  { slug: 'ferronorte', name: 'Ferro Norte Siderurgia', domain: 'ferronorte.com.br', industry: 'metals', employees: 8400, revenue: 2_860_000_000,
    street: 'Avenida Amazonas 4200', city: 'Belo Horizonte', state: 'Minas Gerais', postal: '30411-000', country: 'Brazil', region: 'latam',
    plants: 6, assets: 528, maturity: 'plant_wide', platforms: ['siemens', 'abb'], lifecycle: 'opportunity', type: 'prospect',
    source: 'field_event', sourceDetail: 'São Paulo industry 4.0 breakfast', founded: 1958, key: true, tier: 'premium', owner: 1, createdDaysAgo: 196, names: 'br',
    description: 'Long steel products for construction and infrastructure. Rolling mills where an unplanned stop costs six figures an hour.' },
  { slug: 'pueblaauto', name: 'Puebla Autopartes', domain: 'pueblaautopartes.mx', industry: 'automotive', employees: 6100, revenue: 1_540_000_000,
    street: 'Boulevard Norte 3210', city: 'Puebla', state: 'Puebla', postal: '72225', country: 'Mexico', region: 'latam',
    plants: 4, assets: 690, maturity: 'plant_wide', platforms: ['fanuc', 'rockwell', 'kuka'], lifecycle: 'customer', type: 'customer',
    source: 'customer_referral', sourceDetail: 'Referred by Pemberton Auto Systems', founded: 1985, key: false, tier: 'premium', owner: 3, createdDaysAgo: 258, names: 'iberian',
    description: 'Stamping and welding for North American vehicle programmes. USMCA content rules keep the plant busy and the schedule inflexible.' },
  { slug: 'andina', name: 'Andina Envases', domain: 'andinaenvases.cl', industry: 'packaging', employees: 1100, revenue: 246_000_000,
    street: 'Avenida Américo Vespucio 1740', city: 'Santiago', state: 'Región Metropolitana', postal: '8580000', country: 'Chile', region: 'latam',
    plants: 2, assets: 96, maturity: 'single_line', platforms: ['omron', 'siemens'], lifecycle: 'lead', type: 'prospect',
    source: 'inbound_content', sourceDetail: 'Downloaded the blow-moulding uptime guide', founded: 1989, key: false, tier: 'standard', owner: 3, createdDaysAgo: 38, names: 'iberian',
    description: 'PET and HDPE containers for beverage and chemical customers. Growing exports into Peru and Colombia.' },
  { slug: 'orinoco', name: 'Orinoco Papel', domain: 'orinocopapel.com.co', industry: 'packaging', employees: 1650, revenue: 318_000_000,
    street: 'Calle 100 No. 8-60', city: 'Bogotá', state: 'Cundinamarca', postal: '110221', country: 'Colombia', region: 'latam',
    plants: 3, assets: 122, maturity: 'single_line', platforms: ['rockwell'], lifecycle: 'marketing_qualified_lead', type: 'prospect',
    source: 'outbound_sequence', sourceDetail: 'LATAM packaging sequence, step 1', founded: 1976, key: false, tier: 'standard', owner: 3, createdDaysAgo: 54, names: 'iberian',
    description: 'Paper and board converting for the Andean region. Old machinery, new ownership, and a mandate to modernise.' },
  { slug: 'sterlingheat', name: 'Sterling Heat Treating', domain: 'sterlingheat.com', industry: 'metals', employees: 430, revenue: 96_000_000,
    street: '1400 East Ninth Street', city: 'Cincinnati', state: 'Ohio', postal: '45202', country: 'United States', region: 'north_america',
    plants: 2, assets: 44, maturity: 'pilot', platforms: ['rockwell'], lifecycle: 'other', type: 'former_customer',
    source: 'trade_show', sourceDetail: 'IMTS Chicago 2023', founded: 1962, key: false, tier: 'standard', owner: 4, createdDaysAgo: 520, names: 'us',
    description: 'Commercial heat treating for regional machine shops. Churned in March when their private-equity owner froze all software spend.' },
  { slug: 'lindqvist', name: 'Lindqvist Verktyg', domain: 'lindqvistverktyg.se', industry: 'contract_mfg', employees: 380, revenue: 88_000_000,
    street: 'Verkstadsgatan 9', city: 'Jönköping', state: 'Jönköping', postal: '553 02', country: 'Sweden', region: 'emea',
    plants: 1, assets: 38, maturity: 'pilot', platforms: ['siemens'], lifecycle: 'other', type: 'former_customer',
    source: 'inbound_content', sourceDetail: 'Nordic tooling newsletter', founded: 1993, key: false, tier: 'standard', owner: 3, createdDaysAgo: 486, names: 'nordic',
    description: 'Tool and die shop. Ran a six-month pilot, then was acquired and standardised on the parent group’s platform.' },
];

/* --------------------------------- people -------------------------------- */

export const NAME_POOLS: Record<NameStyle, { first: string[]; last: string[] }> = {
  us: {
    first: [
      'Rachel', 'Dominic', 'Alicia', 'Grant', 'Maureen', 'Curtis', 'Bethany', 'Elliot', 'Shawna', 'Reginald',
      'Kendra', 'Vincent', 'Marlene', 'Trevor', 'Colleen', 'Desmond', 'Priscilla', 'Roland', 'Tamsin', 'Errol',
      'Lorraine', 'Byron', 'Deirdre', 'Wendell', 'Corinne', 'Marcus', 'Yvette', 'Hollis', 'Rosalind', 'Terrence',
      'Imani', 'Garrett', 'Noelle', 'Sterling',
    ],
    last: [
      'Whitaker', 'Okonkwo', 'Delgado', 'Brennan', 'Halloway', 'Pierce', 'Nakamura-Reid', 'Sutcliffe', 'Barnes',
      'Ferraro', 'Lindgren', 'Mahoney', 'Castellanos', 'Boone', 'Ashford', 'Quinlan', 'Vandermeer', 'Osei',
      'Kowalczyk', 'Truong', 'Bellamy', 'Stroud', 'Amoretti', 'Fitzgerald', 'Kaminski', 'Wexler', 'Odum',
      'Prendergast', 'Salcedo', 'Thibodeaux', 'Beaumont', 'Ruiz-Kelly',
    ],
  },
  de: {
    first: ['Annika', 'Jonas', 'Katrin', 'Matthias', 'Sabine', 'Tobias', 'Ingrid', 'Frederik', 'Heike', 'Lukas', 'Petra', 'Sebastian', 'Ulrike', 'Bastian', 'Marlies', 'Reinhold', 'Steffi', 'Gunnar'],
    last: ['Brandt', 'Hofmann', 'Vogel', 'Reinhardt', 'Kühn', 'Schreiber', 'Baumgartner', 'Fischer', 'Wendt', 'Krämer', 'Lehmann', 'Sommer', 'Eberhardt', 'Neuhaus', 'Stellwag', 'Pfeiffer', 'Rothenberg', 'Dittmar'],
  },
  fr: {
    first: ['Camille', 'Thibault', 'Aurélie', 'Mathieu', 'Sylvie', 'Antoine', 'Hélène', 'Damien', 'Nathalie', 'Grégoire'],
    last: ['Lefèvre', 'Moreau', 'Bertrand', 'Chevalier', 'Rousseau', 'Delacroix', 'Marchand', 'Perrin', 'Gauthier', 'Vasseur'],
  },
  nordic: {
    first: ['Emil', 'Astrid', 'Henrik', 'Ingeborg', 'Anders', 'Malin', 'Kasper', 'Solveig', 'Jonas', 'Frida', 'Torbjörn', 'Liv', 'Rasmus', 'Annelie'],
    last: ['Lindqvist', 'Halvorsen', 'Nyström', 'Bergström', 'Dahl', 'Söderberg', 'Kjeldsen', 'Ahlberg', 'Mikkelsen', 'Ekström', 'Vestergaard', 'Sandvik', 'Lindholm', 'Aasen'],
  },
  nl: {
    first: ['Sanne', 'Bram', 'Marieke', 'Joost', 'Fenna', 'Willem', 'Lotte', 'Ruben'],
    last: ['van Dijk', 'de Wit', 'Bakker', 'Vermeulen', 'Jansen', 'van Leeuwen', 'Hendriks', 'Smit'],
  },
  it: {
    first: ['Giulia', 'Matteo', 'Chiara', 'Alessandro', 'Federica', 'Lorenzo', 'Silvia', 'Riccardo'],
    last: ['Bianchi', 'Ferrari', 'Moretti', 'Gallo', 'Rinaldi', 'Costa', 'Barbieri', 'Fontana'],
  },
  iberian: {
    first: ['Lucía', 'Javier', 'Carmen', 'Rodrigo', 'Elena', 'Andrés', 'Paula', 'Ignacio', 'Valentina', 'Mauricio', 'Beatriz', 'Emilio', 'Rocío', 'Nicolás', 'Ximena', 'Gonzalo'],
    last: ['Navarro', 'Ibáñez', 'Fuentes', 'Ramírez', 'Cordero', 'Aguilar', 'Bustamante', 'Salazar', 'Peralta', 'Villalobos', 'Zambrano', 'Olivares', 'Escamilla', 'Quintanilla', 'Arriaga', 'Bermúdez'],
  },
  pl: {
    first: ['Agnieszka', 'Marcin', 'Katarzyna', 'Paweł', 'Magdalena', 'Tomasz'],
    last: ['Kowalczyk', 'Nowicki', 'Wójcik', 'Zawadzki', 'Lewandowska', 'Kamiński'],
  },
  tr: {
    first: ['Elif', 'Burak', 'Zeynep', 'Emre', 'Deniz', 'Kerem'],
    last: ['Yıldırım', 'Demirtaş', 'Aksoy', 'Çetin', 'Kaya', 'Şahin'],
  },
  jp: {
    first: ['Haruka', 'Kenji', 'Yuki', 'Takeshi', 'Naoko', 'Shinji', 'Ayumi', 'Ryo'],
    last: ['Sakamoto', 'Ishikawa', 'Fujimoto', 'Watanabe', 'Kobayashi', 'Yano', 'Morita', 'Tanabe'],
  },
  kr: {
    first: ['Ji-woo', 'Min-jun', 'Seo-yeon', 'Hyun-woo', 'Eun-ji', 'Dae-hyun'],
    last: ['Park', 'Kim', 'Choi', 'Jung', 'Kang', 'Yoon'],
  },
  in: {
    first: ['Ananya', 'Rohit', 'Priyanka', 'Vikram', 'Meera', 'Sanjay', 'Kavita', 'Arjun'],
    last: ['Krishnan', 'Deshpande', 'Iyer', 'Bhatt', 'Reddy', 'Chatterjee', 'Nair', 'Malhotra'],
  },
  cn: {
    first: ['Wei', 'Jing', 'Hao', 'Lin', 'Yan', 'Feng'],
    last: ['Chen', 'Zhang', 'Liu', 'Huang', 'Zhao', 'Xu'],
  },
  br: {
    first: ['Beatriz', 'Rafael', 'Larissa', 'Thiago', 'Camila', 'Eduardo'],
    last: ['Almeida', 'Nogueira', 'Barbosa', 'Carvalho', 'Teixeira', 'Moraes'],
  },
};

export interface RoleSpec {
  title: string;
  department: string;
  seniority: string;
  buyingRole: string;
}

/** The buying committee for a factory telemetry platform, in rough order. */
export const ROLES: RoleSpec[] = [
  { title: 'VP of Manufacturing Operations', department: 'executive', seniority: 'vp', buyingRole: 'economic_buyer' },
  { title: 'Director of Manufacturing Engineering', department: 'engineering', seniority: 'director', buyingRole: 'champion' },
  { title: 'Plant Manager', department: 'operations', seniority: 'manager', buyingRole: 'influencer' },
  { title: 'Maintenance & Reliability Manager', department: 'maintenance', seniority: 'manager', buyingRole: 'champion' },
  { title: 'Controls Engineer', department: 'engineering', seniority: 'individual_contributor', buyingRole: 'technical_evaluator' },
  { title: 'OT Security Architect', department: 'it', seniority: 'individual_contributor', buyingRole: 'blocker' },
  { title: 'Director of Continuous Improvement', department: 'quality', seniority: 'director', buyingRole: 'influencer' },
  { title: 'Head of Digital Manufacturing', department: 'it', seniority: 'director', buyingRole: 'champion' },
  { title: 'Senior Procurement Manager', department: 'procurement', seniority: 'manager', buyingRole: 'blocker' },
  { title: 'Chief Operating Officer', department: 'executive', seniority: 'c_level', buyingRole: 'economic_buyer' },
  { title: 'Automation Team Lead', department: 'engineering', seniority: 'manager', buyingRole: 'technical_evaluator' },
  { title: 'Reliability Engineer', department: 'maintenance', seniority: 'individual_contributor', buyingRole: 'end_user' },
  { title: 'Quality Systems Manager', department: 'quality', seniority: 'manager', buyingRole: 'influencer' },
  { title: 'Production Supervisor', department: 'operations', seniority: 'individual_contributor', buyingRole: 'end_user' },
  { title: 'IT Infrastructure Manager', department: 'it', seniority: 'manager', buyingRole: 'technical_evaluator' },
  { title: 'EHS Manager', department: 'safety', seniority: 'manager', buyingRole: 'influencer' },
  { title: 'Chief Financial Officer', department: 'finance', seniority: 'c_level', buyingRole: 'economic_buyer' },
];
