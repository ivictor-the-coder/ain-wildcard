/**
 * The currencies a price may be denominated in.
 *
 * A three-letter shape check is not a currency check: `zzz` matches `[a-z]{3}`
 * and would otherwise be accepted into `currency_options`, after which the
 * pricing page happily renders "ZZZ 0.50" for the rest of the price's life —
 * and a price's currency can never be edited once anything has billed against
 * it. So the code is checked against the ISO-4217 register on the way in, where
 * the mistake is still cheap to fix.
 *
 * Names are the register's own, and are what the currency picker and the
 * multi-currency tab of a price show next to the code.
 */
import { badRequest } from '../../../shared/errors';

export const CURRENCIES: Record<string, string> = {
  aed: 'UAE dirham', afn: 'Afghan afghani', all: 'Albanian lek', amd: 'Armenian dram',
  ang: 'Netherlands Antillean guilder', aoa: 'Angolan kwanza', ars: 'Argentine peso',
  aud: 'Australian dollar', awg: 'Aruban florin', azn: 'Azerbaijani manat',
  bam: 'Bosnia-Herzegovina convertible mark', bbd: 'Barbadian dollar', bdt: 'Bangladeshi taka',
  bgn: 'Bulgarian lev', bhd: 'Bahraini dinar', bif: 'Burundian franc', bmd: 'Bermudian dollar',
  bnd: 'Brunei dollar', bob: 'Bolivian boliviano', brl: 'Brazilian real', bsd: 'Bahamian dollar',
  btn: 'Bhutanese ngultrum', bwp: 'Botswanan pula', byn: 'Belarusian ruble', bzd: 'Belize dollar',
  cad: 'Canadian dollar', cdf: 'Congolese franc', chf: 'Swiss franc', clp: 'Chilean peso',
  cny: 'Chinese yuan', cop: 'Colombian peso', crc: 'Costa Rican colón', cup: 'Cuban peso',
  cve: 'Cape Verdean escudo', czk: 'Czech koruna', djf: 'Djiboutian franc', dkk: 'Danish krone',
  dop: 'Dominican peso', dzd: 'Algerian dinar', egp: 'Egyptian pound', ern: 'Eritrean nakfa',
  etb: 'Ethiopian birr', eur: 'Euro', fjd: 'Fijian dollar', fkp: 'Falkland Islands pound',
  gbp: 'British pound', gel: 'Georgian lari', ghs: 'Ghanaian cedi', gip: 'Gibraltar pound',
  gmd: 'Gambian dalasi', gnf: 'Guinean franc', gtq: 'Guatemalan quetzal', gyd: 'Guyanaese dollar',
  hkd: 'Hong Kong dollar', hnl: 'Honduran lempira', htg: 'Haitian gourde', huf: 'Hungarian forint',
  idr: 'Indonesian rupiah', ils: 'Israeli new shekel', inr: 'Indian rupee', iqd: 'Iraqi dinar',
  irr: 'Iranian rial', isk: 'Icelandic króna', jmd: 'Jamaican dollar', jod: 'Jordanian dinar',
  jpy: 'Japanese yen', kes: 'Kenyan shilling', kgs: 'Kyrgystani som', khr: 'Cambodian riel',
  kmf: 'Comorian franc', kpw: 'North Korean won', krw: 'South Korean won', kwd: 'Kuwaiti dinar',
  kyd: 'Cayman Islands dollar', kzt: 'Kazakhstani tenge', lak: 'Laotian kip', lbp: 'Lebanese pound',
  lkr: 'Sri Lankan rupee', lrd: 'Liberian dollar', lsl: 'Lesotho loti', lyd: 'Libyan dinar',
  mad: 'Moroccan dirham', mdl: 'Moldovan leu', mga: 'Malagasy ariary', mkd: 'Macedonian denar',
  mmk: 'Myanmar kyat', mnt: 'Mongolian tugrik', mop: 'Macanese pataca', mru: 'Mauritanian ouguiya',
  mur: 'Mauritian rupee', mvr: 'Maldivian rufiyaa', mwk: 'Malawian kwacha', mxn: 'Mexican peso',
  myr: 'Malaysian ringgit', mzn: 'Mozambican metical', nad: 'Namibian dollar', ngn: 'Nigerian naira',
  nio: 'Nicaraguan córdoba', nok: 'Norwegian krone', npr: 'Nepalese rupee', nzd: 'New Zealand dollar',
  omr: 'Omani rial', pab: 'Panamanian balboa', pen: 'Peruvian sol', pgk: 'Papua New Guinean kina',
  php: 'Philippine peso', pkr: 'Pakistani rupee', pln: 'Polish złoty', pyg: 'Paraguayan guarani',
  qar: 'Qatari rial', ron: 'Romanian leu', rsd: 'Serbian dinar', rub: 'Russian ruble',
  rwf: 'Rwandan franc', sar: 'Saudi riyal', sbd: 'Solomon Islands dollar', scr: 'Seychellois rupee',
  sdg: 'Sudanese pound', sek: 'Swedish krona', sgd: 'Singapore dollar', shp: 'St Helena pound',
  sle: 'Sierra Leonean leone', sos: 'Somali shilling', srd: 'Surinamese dollar',
  ssp: 'South Sudanese pound', stn: 'São Tomé and Príncipe dobra', svc: 'Salvadoran colón',
  syp: 'Syrian pound', szl: 'Swazi lilangeni', thb: 'Thai baht', tjs: 'Tajikistani somoni',
  tmt: 'Turkmenistani manat', tnd: 'Tunisian dinar', top: 'Tongan paʻanga', try: 'Turkish lira',
  ttd: 'Trinidad and Tobago dollar', twd: 'New Taiwan dollar', tzs: 'Tanzanian shilling',
  uah: 'Ukrainian hryvnia', ugx: 'Ugandan shilling', usd: 'US dollar', uyu: 'Uruguayan peso',
  uzs: 'Uzbekistani som', ves: 'Venezuelan bolívar', vnd: 'Vietnamese dong', vuv: 'Vanuatu vatu',
  wst: 'Samoan tala', xaf: 'Central African CFA franc', xcd: 'East Caribbean dollar',
  xcg: 'Caribbean guilder', xof: 'West African CFA franc', xpf: 'CFP franc', yer: 'Yemeni rial',
  zar: 'South African rand', zmw: 'Zambian kwacha', zwg: 'Zimbabwe gold',
};

export const CURRENCY_CODES: string[] = Object.keys(CURRENCIES).sort();

export const isCurrency = (code: string): boolean =>
  Object.prototype.hasOwnProperty.call(CURRENCIES, String(code).toLowerCase());

export const currencyName = (code: string): string =>
  CURRENCIES[String(code).toLowerCase()] ?? String(code).toUpperCase();

/** Normalise a currency code, or refuse it by name the way Stripe does. */
export function assertCurrency(raw: unknown, param = 'currency'): string {
  const code = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) {
    throw badRequest('parameter_invalid', `"${raw}" is not a 3-letter ISO-4217 currency code.`, param);
  }
  if (!isCurrency(code)) {
    throw badRequest(
      'parameter_invalid',
      `Invalid currency: ${code}. Use a lowercase ISO-4217 code such as usd, eur or gbp — a price's currency can never be changed once it has billed.`,
      param,
    );
  }
  return code;
}
