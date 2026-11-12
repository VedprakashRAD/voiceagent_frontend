import { Routes } from '@angular/router';
import { UserSelectionComponent } from './pages/user-selection/user-selection.component';
import { VoiceAgentComponent } from './pages/voice-agent/voice-agent.component';

export const routes: Routes = [
  { path: '', component: UserSelectionComponent, data: { animation: 'HomePage' } },
  { path: 'chat', component: VoiceAgentComponent, data: { animation: 'ChatPage' } },
  { path: '**', redirectTo: '' }
];
