import { Component } from '@angular/core';
import { RouterOutlet, ChildrenOutletContexts } from '@angular/router';
import { routeAnimations } from './animations';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  animations: [routeAnimations],
  template: `
    <main [@routeAnimations]="getRouteAnimationData()" style="position: relative; width: 100%; height: 100vh; overflow: hidden;">
      <router-outlet></router-outlet>
    </main>
  `,
})
export class App {
  constructor(private contexts: ChildrenOutletContexts) {}

  getRouteAnimationData() {
    return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation'];
  }
}
