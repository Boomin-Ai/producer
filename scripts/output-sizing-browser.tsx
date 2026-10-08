import {createRoot} from 'react-dom/client';
import AudiencePage from '../server/guest/src/AudiencePage';
window.fetch=()=>new Promise(()=>{});
createRoot(document.getElementById('root')!).render(<AudiencePage code="sizing-proof"/>);
