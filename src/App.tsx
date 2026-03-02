/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import OrderAssembly from './pages/OrderAssembly';
import ReturnsReceiving from './pages/ReturnsReceiving';
import ChzTasks from './pages/ChzTasks';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<OrderAssembly />} />
          <Route path="returns" element={<ReturnsReceiving />} />
          <Route path="chz-tasks" element={<ChzTasks />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
