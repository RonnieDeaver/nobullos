/**
 * AM Dashboard — shipped launch-URL seed (46 URLs collected for Juan's Client
 * Dashboard prototype, Aug 2026 handoff), keyed "product:cid".
 *
 * A working Google Ads deep link needs an `ocid` — and an LSA link a `cid` —
 * that is an opaque Google value with NO derivable relationship to the Customer
 * ID; URLs can only be captured by a human opening the account once. A ClickUp
 * subtask field whose name contains "account link" / "deep link" overrides
 * this seed (clickUpDirectory.clickUpDeepLinks) — the recommended end state.
 *
 * A TS module (not a JSON file read at runtime) so the seed survives the CJS
 * production bundle verbatim — a file path resolved at runtime would dangle in
 * dist/index.cjs. Values are copied UNEDITED from the reference bundle's
 * am_deeplinks.json; the http(s) scheme filter still runs in amDashboard.ts so
 * a future edit here can't smuggle a non-http scheme into an href.
 */
export const AM_DEEPLINKS_SEED: Record<string, string> = {
  "gads:1142840199":
    "https://ads.google.com/aw/overview?ocid=7130329825&ascid=7130329825&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:1668823783":
    "https://ads.google.com/aw/overview?ocid=99309320&ascid=99309320&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:1818611005":
    "https://ads.google.com/aw/overview?ocid=8020759574&workspaceId=0&ascid=8020759574&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:2521864966":
    "https://ads.google.com/aw/overview?ocid=780682270&workspaceId=-2051856070&ascid=780682270&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:3084663670":
    "https://ads.google.com/aw/overview?ocid=674243265&ascid=674243265&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:3447889098":
    "https://ads.google.com/aw/overview?ocid=1231016325&ascid=1231016325&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:3966261854":
    "https://ads.google.com/aw/overview?campaignId=23767201912&ocid=8037561062&workspaceId=0&ascid=8037561062&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:4134818123":
    "https://ads.google.com/aw/overview?ocid=79916875&ascid=79916875&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:4225256139":
    "https://ads.google.com/aw/overview?ocid=7980036921&ascid=7980036921&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:4309084652":
    "https://ads.google.com/aw/overview?ocid=1202909939&ascid=1202909939&authuser=0&__u=7614784959&__c=7614821178",
  "gads:4333959201":
    "https://ads.google.com/aw/overview?ocid=6671380225&workspaceId=0&ascid=6671380225&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:4428699921":
    "https://ads.google.com/aw/overview?ocid=402350384&ascid=402350384&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:5036860353":
    "https://ads.google.com/aw/overview?ocid=151471705&ascid=151471705&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:5480315617":
    "https://ads.google.com/aw/overview?ocid=6625808297&ascid=6625808297&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:5637627539":
    "https://ads.google.com/aw/overview?ocid=768502769&ascid=768502769&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:6083427412":
    "https://ads.google.com/aw/overview?ocid=120104722&workspaceId=-2074554459&ascid=120104722&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:6320038010":
    "https://ads.google.com/aw/overview?ocid=92767766&ascid=92767766&authuser=0&__u=7614784959&__c=7614821178",
  "gads:6837251501":
    "https://ads.google.com/aw/overview?ocid=8371019705&ascid=8371019705&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:7591197086":
    "https://ads.google.com/aw/overview?ocid=8223286517&ascid=8223286517&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:7640290354":
    "https://ads.google.com/aw/overview?ocid=327440089&workspaceId=-1724770929&ascid=327440089&euid=1391966867&__u=3928305083&uscid=733700784&__c=1259085616&authuser=0",
  "gads:8010814496":
    "https://ads.google.com/aw/campaigns?ocid=1508355032&workspaceId=-1726728116&ascid=1508355032&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:9142004511":
    "https://ads.google.com/aw/overview?ocid=1666811228&ascid=1666811228&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "gads:9446178488":
    "https://ads.google.com/aw/overview?campaignId=22870491517&ocid=7354849380&workspaceId=-1336367226&ascid=7354849380&euid=833502391&__u=7614784959&uscid=296032522&__c=7614821178&authuser=0",
  "lsa:1142840199":
    "https://ads.google.com/localservices/verification?cid=4896646425&bid=10916518529&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:2146364898":
    "https://ads.google.com/localservices/verification?cid=3893551318&bid=2536666932&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:3084663670":
    "https://ads.google.com/localservices/verification?cid=7558356985&bid=8182010552&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:3212570953":
    "https://ads.google.com/localservices/verification?cid=1689950858&bid=2665935138&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:3215842288":
    "https://ads.google.com/localservices/verification?cid=6172243240&bid=10123044248&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:3447889098":
    "https://ads.google.com/localservices/verification?cid=7761984925&bid=3853778659&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:4225256139":
    "https://ads.google.com/localservices/verification?cid=5914250929&bid=10992069158&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:4513993449":
    "https://ads.google.com/localservices/verification?cid=2433536816&bid=2604870729&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:5319654244":
    "https://ads.google.com/localservices/verification?cid=7606532336&bid=10228219252&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:5342807358":
    "https://ads.google.com/localservices/verification?cid=5825173343&bid=11025699160&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:5607467296":
    "https://ads.google.com/localservices/verification?cid=9058097763&bid=11029185681&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:5637627539":
    "https://ads.google.com/localservices/verification?cid=4981395881&bid=2576332886&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:6083427412":
    "https://ads.google.com/localservices/verification?cid=7673118978&bid=2583363873&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:6837251501":
    "https://ads.google.com/localservices/verification?cid=9215754545&bid=11034872435&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:7035318093":
    "https://ads.google.com/localservices/verification?cid=9726983256&bid=11025860315&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:7591197086":
    "https://ads.google.com/localservices/verification?cid=3511937933&bid=11013412791&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:7640290354":
    "https://ads.google.com/localservices/verification?cid=5241780561&bid=2547738440&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:7814332199":
    "https://ads.google.com/localservices/verification?cid=4060800882&bid=2579975761&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:8596040750":
    "https://ads.google.com/localservices/verification?cid=8572229318&bid=2558750935&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:8812544205":
    "https://ads.google.com/localservices/verification?cid=2542512300&bid=10214385206&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:9364276756":
    "https://ads.google.com/localservices/verification?cid=5404982532&bid=11021360187&pid=9999999999&mcid=1259085616&euid=3928305083&hl=en&gl=US",
  "lsa:9446178488":
    "https://ads.google.com/localservices/verification?cid=3888023620&bid=10932886556&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
  "lsa:9590510207":
    "https://ads.google.com/localservices/verification?cid=6701455171&bid=2539040862&pid=9999999999&mcid=1259085616&euid=7614784959&hl=en-GB&gl=US",
};
