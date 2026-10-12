import styles from "./landing.module.css";
import { branding } from "@/lib/branding";
import TopBar from "./components/landing/TopBar";
import Hero from "./components/landing/Hero";
import HowItWorks from "./components/landing/HowItWorks";
import Holds from "./components/landing/Holds";
import GetStarted from "./components/landing/GetStarted";
import Faq from "./components/landing/Faq";
import Footer from "./components/landing/Footer";

/**
 * The landing page is the demo (owner, 2026-09-18: "so I don't need to record a demo").
 * Order is the order a newcomer needs: what it is and how it works (hero + tour), what
 * Installation comes straight after the hero (owner, 2026-09-18): someone sold by the
 * headline should not have to scroll past the explanation to find the one line they need.
 * Then how it works, then what you get (owner, 2026-09-18: show the mechanism before the
 * argument; 2026-09-23: the why and what-it-holds sections merged into one). Under a minute, for any team.
 */
export default function Home() {
  return (
    <div className={styles.page}>
      <TopBar orgName={branding().orgName} />
      <main>
        <Hero />
        <GetStarted />
        <HowItWorks />
        <Holds />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
