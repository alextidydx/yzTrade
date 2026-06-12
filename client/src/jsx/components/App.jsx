import React from 'react';
import { BrowserRouter, Routes, Route } from "react-router-dom"
import '../../styles/App.scss'
import Home from './pages/Home';

// Global sitemap with routes and payloads
const sitemap = [
	{
		id : 0,
		path : "*",
		element : Home,
		settings : {}
	},
	{
		id : 1,
		path : "/*",
		element : Home,
		settings : {}
	}
];

const App = () => {
	return (
		<BrowserRouter>
			<Routes>
				{sitemap.map(page => {
					const Component = page.element;
					return <Route path={page.path} key={page.id} element={<Component settings={page.settings} />} />;
				})}
			</Routes>
		</BrowserRouter>
	);
};


export default App;
