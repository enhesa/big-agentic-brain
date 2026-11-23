import styles from "./landing.module.css";
import { branding } from "@/lib/branding";
import TopBar from "./components/landing/TopBar";
import Hero from "./components/landing/Hero";
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
 * 2. The film tells the story, once: why agents need a shared brain and how it works. On a
 *    wide screen it is pinned and the scroll plays it, act by act; elsewhere it is a player.
 * 3. What you get: one example of each thing it holds, and the house rules.
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
        <Holds />
        <GetStarted />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
