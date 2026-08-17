import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api.js';
import { useAuth, Loading } from './lib/ui.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Drivers from './pages/Drivers.jsx';
import DriverRegister from './pages/DriverRegister.jsx';
import DriverProfile from './pages/DriverProfile.jsx';
import Deployments from './pages/Deployments.jsx';
import Attendance from './pages/Attendance.jsx';
import Insurance from './pages/Insurance.jsx';
import Advances from './pages/Advances.jsx';
import Expenses from './pages/Expenses.jsx';
import Salary from './pages/Salary.jsx';
import Tally from './pages/Tally.jsx';
import Messaging from './pages/Messaging.jsx';
import Users from './pages/Users.jsx';

const NAV = [
  { group: 'Operations' },
  { to: '/', label: 'Dashboard', icon: '▤', exact: true },
  { to: '/drivers', label: 'Drivers', icon: '👤' },
  { to: '/deployments', label: 'Deployments', icon: '🚗' },
  { to: '/attendance', label: 'Attendance', icon: '🗓' },
  { to: '/insurance', label: 'Insurance', icon: '🛡' },
  { group: 'Finance' },
  { to: '/advances', label: 'Advances', icon: '₹', badge: 'advances' },
  { to: '/expenses', label: 'Expenses', icon: '🧾', badge: 'expenses' },
  { to: '/salary', label: 'Salary', icon: '📄' },
  { to: '/tally', label: 'Tally Linkage', icon: '⇄', roles: ['accounts', 'senior_manager', 'director'] },
  { group: 'Communication' },
  { to: '/messaging', label: 'WhatsApp', icon: '💬' },
  { to: '/users', label: 'Users', icon: '⚙', roles: [] },
];

export default function App() {
  const { user, ready } = useAuth();
  const location = useLocation();
  const [badges, setBadges] = useState({ advances: 0, expenses: 0 });

  useEffect(() => {
    if (!user) return;
    Promise.all([
      api.get('/advances/inbox').catch(() => null),
      api.get('/expenses/inbox').catch(() => null),
    ]).then(([adv, exp]) => {
      const forMe = (inbox) => {
        if (!inbox) return 0;
        if (user.role === 'senior_manager') return inbox.pending_sm;
        if (user.role === 'director') return inbox.pending_director;
        if (user.role === 'accounts') return inbox.approved_unpaid ?? inbox.open_settlements ?? 0;
        if (user.role === 'admin') return inbox.pending_sm + inbox.pending_director;
        return inbox.my_requests ?? 0;
      };
      setBadges({ advances: forMe(adv), expenses: forMe(exp) });
    });
  }, [user, location.pathname]);

  if (!ready) return <Loading what="your session" />;
  if (!user) return <Login />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <b>Quantum</b>
          <span>Driver Management</span>
        </div>
        <nav>
          {NAV.map((item, i) => {
            if (item.group) return <div className="group" key={`g${i}`}>{item.group}</div>;
            // roles: [] means admin only (admin passes every check).
            if (item.roles && !(user.role === 'admin' || item.roles.includes(user.role))) return null;
            const count = item.badge ? badges[item.badge] : 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) => `item${isActive ? ' active' : ''}`}
              >
                <span className="ic">{item.icon}</span>
                {item.label}
                {count > 0 && <span className="count">{count}</span>}
              </NavLink>
            );
          })}
        </nav>
        <UserBox />
      </aside>

      <div className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/drivers" element={<Drivers />} />
          <Route path="/drivers/new" element={<DriverRegister />} />
          <Route path="/drivers/:id" element={<DriverProfile />} />
          <Route path="/deployments" element={<Deployments />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/insurance" element={<Insurance />} />
          <Route path="/advances" element={<Advances />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/salary" element={<Salary />} />
          <Route path="/tally" element={<Tally />} />
          <Route path="/messaging" element={<Messaging />} />
          <Route path="/users" element={<Users />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function UserBox() {
  const { user, signOut } = useAuth();
  const label = {
    admin: 'Administrator', supervisor: 'Supervisor', senior_manager: 'Senior Manager',
    director: 'Director', accounts: 'Accounts',
  }[user.role];
  return (
    <div className="who">
      <b>{user.name}</b>
      <span>{label}</span>
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}

export function Page({ title, subtitle, actions, children }) {
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        <div className="spacer" />
        {actions}
      </div>
      <div className="content">{children}</div>
    </>
  );
}
