import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { UploadScanPage } from './pages/UploadScanPage';
import { CodeWorkbenchPage } from './pages/CodeWorkbenchPage';
import { BugIntelligencePage } from './pages/BugIntelligencePage';
import { ImpactRadarPage } from './pages/ImpactRadarPage';
import { WebsiteDebuggerPage } from './pages/WebsiteDebuggerPage';
import { MultimediaDebuggerPage } from './pages/MultimediaDebuggerPage';
import { AuditTrailPage } from './pages/AuditTrailPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/upload" element={<UploadScanPage />} />
          <Route path="/workbench" element={<CodeWorkbenchPage />} />
          <Route path="/intelligence" element={<BugIntelligencePage />} />
          <Route path="/radar" element={<ImpactRadarPage />} />
          <Route path="/website-debugger" element={<WebsiteDebuggerPage />} />
          <Route path="/multimedia-debugger" element={<MultimediaDebuggerPage />} />
          <Route path="/audit" element={<AuditTrailPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
