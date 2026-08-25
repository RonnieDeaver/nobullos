/**
 * Canonical NoBull team roster.
 *
 * Both the homepage and About page render this exact order, photo, name, and
 * role contract. The three biographies are the existing About-page copy; an
 * omitted bio means no biography has been approved for publication.
 */
export interface TeamMember {
  readonly img: string;
  readonly name: string;
  readonly role: string;
  readonly bio?: string;
}

export const TEAM_ROSTER: readonly TeamMember[] = [
  {
    img: "ronnie2.jpg",
    name: "Ronnie Deaver",
    role: "Founder",
    bio: "Ronnie Deaver founded NoBull Marketing after more than a decade engineering revenue for law firms. He’s the author of The Law Firm Revenue Engine and a speaker at industry events including the American Bar Association and the National Association of Divorce Professionals.",
  },
  {
    img: "oliver.webp",
    name: "Oliver Goessler",
    role: "Head of Operations",
    bio: "Oliver keeps the engine room running: he designs and implements the systems behind every NoBull client account and makes sure the whole operation performs. He is trilingual, having grown up speaking native English and native German, as well as speaking Spanish thanks to having lived in Mexico.",
  },
  { img: "brett2.jpg", name: "Brett Barney", role: "Head of Accounts" },
  { img: "jeff.jpg", name: "Jeff Mangle", role: "Head of Sales" },
  { img: "janno2.jpg", name: "Janno Perez", role: "Head of Paid Search" },
  { img: "cam.jpg", name: "Cam Duhart", role: "Sr. Intake Engineer" },
  {
    img: "jake2.jpg",
    name: "Jake Davis",
    role: "Sr. Marketing Engineer",
    bio: "With 11+ years of experience managing full-circle marketing campaigns, Jake has worked with small and medium-sized businesses across the country to help them achieve their marketing goals. He leverages his experience and expertise to create exceptional client experiences at NoBull Marketing.",
  },
  { img: "cat2.jpg", name: "Cat McManus", role: "Executive Assistant" },
  { img: "jason.jpg", name: "Jason Robbins", role: "Marketing Engineer" },
  { img: "priyanka.jpg", name: "Priyanka Lakha", role: "Onboarding Engineer" },
  { img: "juan.jpg", name: "Juan Antoniazzi", role: "Paid Search Expert" },
  { img: "santiago.jpg", name: "Santiago Sanchez", role: "Paid Search Expert" },
  { img: "kaylie.jpg", name: "Kaylie Dietrichsen", role: "Paid Search Expert" },
  { img: "devin.jpg", name: "Devin Petersen", role: "Paid Search Expert" },
  {
    img: "jordan.jpg",
    name: "Jordan Scrimgeour",
    role: "Google Business Profile Expert",
  },
  { img: "liri.jpg", name: "Liri Abdullahu", role: "Intake Expert" },
  { img: "cleo.jpg", name: "Cleo Ortega", role: "Virtual Assistant" },
  { img: "lotis.jpg", name: "Lotis Florida", role: "Virtual Assistant" },
];