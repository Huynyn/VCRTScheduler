import { useState, useRef } from 'react';
import Header from './components/layout/Header.jsx';
import Footer from './components/layout/Footer.jsx';
import ResponderForm from './components/responders/ResponderForm.jsx';
import ResponderList from './components/responders/ResponderList.jsx';
import PairingRules from './components/responders/PairingRules.jsx';
import SchedulePanel from './components/scheduling/SchedulePanel.jsx';
import { ResponderProvider, useResponders } from './context/ResponderContext.jsx';

function StepHeading({ n, title, subtitle }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="h-8 w-8 rounded-full bg-garnet-500 text-white text-sm font-bold flex items-center justify-center shadow-sm shrink-0">
        {n}
      </span>
      <div>
        <h2 className="text-lg font-semibold text-secondary-700 leading-tight">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 leading-tight">{subtitle}</p>}
      </div>
    </div>
  );
}

function Workspace() {
  const { addResponder, updateResponder, responders } = useResponders();
  const [editing, setEditing] = useState(null);
  const formRef = useRef(null);

  const handleSave = (responder) => {
    if (editing) updateResponder(editing.id, responder);
    else addResponder(responder);
    setEditing(null);
  };

  const handleEdit = (responder) => {
    setEditing(responder);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-10">
      <section>
        <StepHeading
          n={1}
          title="Build the roster"
          subtitle="Add responders by hand, or load the sample team to try the scheduler."
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div ref={formRef} className="scroll-mt-6">
            <ResponderForm
              editing={editing}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          </div>
          <ResponderList onEdit={handleEdit} editingId={editing?.id} />
        </div>
      </section>

      {responders.length > 1 && (
        <section>
          <StepHeading n={2} title="Set pairing rules" />
          <PairingRules />
        </section>
      )}

      <section>
        <StepHeading
          n={responders.length > 1 ? 3 : 2}
          title="Generate & export"
          subtitle="Build up to 20 of the best weekly schedules and download the PDF."
        />
        <SchedulePanel />
      </section>
    </main>
  );
}

export default function App() {
  return (
    <ResponderProvider>
      <div className="min-h-screen flex flex-col">
        <Header />
        <Workspace />
        <Footer />
      </div>
    </ResponderProvider>
  );
}
