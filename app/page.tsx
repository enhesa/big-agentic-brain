import styles from "./landing.module.css";
import { branding } from "@/lib/branding";
import TopBar from "./components/landing/TopBar";
import Hero from "./components/landing/Hero";
import HowItWorks from "./components/landing/HowItWorks";
import Holds from "./components/landing/Holds";
import Film from "./components/landing/Film";
import GetStarted from "./components/landing/GetStarted";
import Faq from "./components/landing/Faq";
import Footer from "./components/shell/Footer";

/**
 * The landing page is the demo, so nobody has to record one. It is laid out like a short film,
 * in the order a newcomer needs:
 *
 * 1. The first screen says what it is and holds the two install commands: someone sold by the
 *    headline does not have to scroll to find them.
 * 2. The film tells the story. On a wide screen it is pinned and the scroll plays it, act by
 *    act; elsewhere it is a player in the page.
 * 3. How it works shows the mechanism as a diagram, then what you get makes the argument.
 * 4. Installation again, in full, and the questions people ask.
 *
 * Under a minute, for any team.
 */
export default function Home() {
  return (
    <div className={styles.page}>
      <TopBar orgName={branding().orgName} />
      <main>
        <Hero />
        <Film />
        <HowItWorks />
        <Holds />
        <GetStarted />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
