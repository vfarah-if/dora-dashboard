import { Route, Routes } from "react-router";
import { useMe } from "./api/hooks";
import { copy } from "./copy";
import { Header } from "./components/Header";
import { SignIn } from "./components/SignIn";
import { ErrorState, Skeleton } from "./components/States";
import { IssuePage } from "./pages/IssuePage";
import { IssuesPage } from "./pages/IssuesPage";
import { HomePage } from "./pages/HomePage";
import { ReposPage } from "./pages/ReposPage";
import { RepoPage } from "./pages/RepoPage";
import { ComparePage } from "./pages/ComparePage";
import { SpacePage } from "./pages/SpacePage";
import { SpacesPage } from "./pages/SpacesPage";
import { ReviewQueuePage } from "./pages/ReviewQueuePage";

export function App() {
  const me = useMe();

  let content;
  if (me.isPending) content = <Skeleton height={200} label={copy.auth.checking} />;
  else if (me.isError) content = <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  else if (!me.data.user) content = <SignIn auth={me.data} />;
  else
    content = (
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/repos" element={<ReposPage />} />
        <Route path="/repos/:id" element={<RepoPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/spaces" element={<SpacesPage />} />
        <Route path="/spaces/:id" element={<SpacePage />} />
        <Route path="/issues" element={<IssuesPage />} />
        <Route path="/issues/:id" element={<IssuePage />} />
        <Route path="/review-queue" element={<ReviewQueuePage />} />
        <Route path="*" element={<ReposPage />} />
      </Routes>
    );

  return (
    <>
      <a className="skip-link" href="#main">
        {copy.skipToContent}
      </a>
      <Header auth={me.data} />
      <main id="main" className="app-main" tabIndex={-1}>
        {content}
      </main>
    </>
  );
}
