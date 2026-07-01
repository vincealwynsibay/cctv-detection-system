import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { IntersectionsPage } from './pages/Intersections';
import { ReportsPage } from './pages/Reports';
import { UsersPage } from './pages/Users';
import { SignalTimingPage } from './pages/SignalTiming';
import { CameraDetailPage } from './pages/CameraDetail';
import { CamerasPage } from './pages/Cameras';
import { VideosPage } from './pages/Videos';
import { IntersectionDetailPage } from './pages/IntersectionDetail';
import { IntersectionReportPage } from './pages/IntersectionReport';
import { IntersectionStoryPage } from './pages/IntersectionStory';
import { IntersectionShell } from './components/IntersectionShell';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<IntersectionsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="cameras" element={<CamerasPage />} />
            {/* IntersectionShell renders the shared header + tabs spine.
                Story is the default landing tab so operators and panellists
                land in the narrative, not in the engineering view. The old
                Live-camera + warrant-chips page lives at /live as a drill-down. */}
            <Route path="intersections/:id" element={<IntersectionShell />}>
              <Route index               element={<IntersectionStoryPage />} />
              <Route path="live"         element={<IntersectionDetailPage />} />
              <Route path="timing"       element={<SignalTimingPage />} />
              <Route path="report"       element={<IntersectionReportPage />} />
            </Route>
            <Route path="intersections/:intersectionId/cameras/:id" element={<CameraDetailPage />} />
            <Route path="videos"     element={<VideosPage />} />
            <Route path="videos/:id" element={<VideosPage />} />

            {/* Legacy routes - keep working but redirect to home */}
            <Route path="intersections"   element={<Navigate to="/" replace />} />
            <Route path="recommendations" element={<Navigate to="/" replace />} />
            <Route path="dashboard"       element={<Navigate to="/" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
