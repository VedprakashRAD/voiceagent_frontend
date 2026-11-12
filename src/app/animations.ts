import { trigger, transition, style, query, animate, group } from '@angular/animations';

export const routeAnimations = trigger('routeAnimations', [
  transition('* <=> *', [
    style({ position: 'relative' }),
    query(':enter, :leave', [
      style({
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        // Ensure backgrounds don't bleed if elements are transparent
        backgroundColor: 'transparent'
      })
    ], { optional: true }),
    // Entering page starts slightly lower, scaled down, and completely transparent
    query(':enter', [
      style({ opacity: 0, transform: 'translateY(40px) scale(0.98)' })
    ], { optional: true }),
    group([
      // Leaving page smoothly fades out and shrinks into the background
      query(':leave', [
        animate('450ms cubic-bezier(0.16, 1, 0.3, 1)', style({ opacity: 0, transform: 'scale(0.92) translateY(-20px)' }))
      ], { optional: true }),
      // Entering page glides up and expands to fill the screen
      query(':enter', [
        animate('600ms 100ms cubic-bezier(0.16, 1, 0.3, 1)', style({ opacity: 1, transform: 'translateY(0) scale(1)' }))
      ], { optional: true })
    ])
  ])
]);
