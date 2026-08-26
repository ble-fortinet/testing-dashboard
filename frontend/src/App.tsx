import { NavLink, Route, Routes } from "react-router-dom";
import { TestingPage } from "./pages/TestingPage.js";
import { LoggingPage } from "./pages/LoggingPage.js";

const navChip = ({ isActive }: { isActive: boolean }) =>
  `ds-chip${isActive ? " is-selected" : ""}`;

export function App() {
  return (
    <div className="ds-root app-shell">
      <header className="app-header">
        <div className="app-title-group">
          <span className="ds-eyebrow app-eyebrow-accent">Internal Tool · Skeleton</span>
          <h1 className="ds-headline app-title">HR Chatbot Testing &amp; Logging</h1>
        </div>
        <nav className="app-nav">
          <NavLink to="/testing" className={navChip}>
            Testing
          </NavLink>
          <NavLink to="/logging" className={navChip}>
            Logging
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/testing" element={<TestingPage />} />
          <Route path="/logging" element={<LoggingPage />} />
          <Route path="*" element={<TestingPage />} />
        </Routes>
      </main>
    </div>
  );
}
