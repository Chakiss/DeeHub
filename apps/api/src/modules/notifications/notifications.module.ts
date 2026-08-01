import { Module } from '@nestjs/common';
import { ComposeNotificationsUseCase } from './application/compose-notifications.usecase';
import { DispatchNotificationsUseCase } from './application/dispatch-notifications.usecase';
import { ListNotificationsQuery } from './application/list-notifications.query';
import { NOTIFICATION_SENDERS } from './domain/notification-sender';
import { LineMessagingSender } from './infrastructure/line-messaging.sender';
import { ResendEmailSender } from './infrastructure/resend-email.sender';
import { NotificationsController } from './interface/notifications.controller';

/**
 * Messages the system owes people.
 *
 * Imported by BOTH the API and the worker, like the channels module: the API
 * serves the log screen, the worker composes and delivers. The senders are
 * assembled here — one list, one place to add a provider — so nothing above
 * the port knows which provider is behind a channel.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    ResendEmailSender,
    LineMessagingSender,
    {
      provide: NOTIFICATION_SENDERS,
      useFactory: (email: ResendEmailSender, line: LineMessagingSender) => [email, line],
      inject: [ResendEmailSender, LineMessagingSender],
    },
    ComposeNotificationsUseCase,
    DispatchNotificationsUseCase,
    ListNotificationsQuery,
  ],
  // NOTIFICATION_SENDERS is exported for the one message that must NOT be
  // logged: a password reset link, which the delivery-log screen would show to
  // anyone holding `notification:read`. Auth sends that one straight down the
  // port. Everything else still goes through the outbox and the log.
  exports: [
    ComposeNotificationsUseCase,
    DispatchNotificationsUseCase,
    ListNotificationsQuery,
    NOTIFICATION_SENDERS,
  ],
})
export class NotificationsModule {}
