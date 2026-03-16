import { Component, inject, effect } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  constructor() {
    effect(() => {
      const loading = this.authService.loading();
      const user = this.authService.currentUser();
      if (!loading && !user) {
        this.router.navigate(['/login']);
      }
    });
  }
}
