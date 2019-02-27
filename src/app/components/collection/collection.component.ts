import { Component, OnInit, ViewEncapsulation, NgZone, OnDestroy } from '@angular/core';
import { CollectionService } from '../../services/collection.service';
import { Notebook } from '../../data/entities/notebook';
import { MatDialog, MatDialogRef, MatTabChangeEvent } from '@angular/material';
import { TranslateService } from '@ngx-translate/core';
import { InputDialogComponent } from '../dialogs/inputDialog/inputDialog.component';
import { ErrorDialogComponent } from '../dialogs/errorDialog/errorDialog.component';
import { SnackBarService } from '../../services/snackBar.service';
import { Subscription, Subject } from 'rxjs';
import { ConfirmationDialogComponent } from '../dialogs/confirmationDialog/confirmationDialog.component';
import { RenameNotebookDialogComponent } from '../dialogs/renameNotebookDialog/renameNotebookDialog.component';
import { Constants } from '../../core/constants';
import log from 'electron-log';
import { Operation } from '../../core/enums';

@Component({
  selector: 'collection-page',
  templateUrl: './collection.component.html',
  styleUrls: ['./collection.component.scss'],
  encapsulation: ViewEncapsulation.None
})
export class CollectionComponent implements OnInit, OnDestroy {
  constructor(private dialog: MatDialog, private collectionService: CollectionService,
    private translateService: TranslateService, private snackBarService: SnackBarService, private zone: NgZone) {
  }

  public applicationName: string = Constants.applicationName;
  private subscription: Subscription;
  public notebooksCount: number = 0;
  public allNotesCount: number = 0;
  public todayNotesCount: number = 0;
  public yesterdayNotesCount: number = 0;
  public thisWeekNotesCount: number = 0;
  public markedNotesCount: number = 0;
  public notebooks: Notebook[];
  public selectedNotebook: Notebook;
  public canEditNotebook: boolean = false;

  public tabChangedSubject: Subject<any> = new Subject();

  get allCategory() {
    return Constants.allCategory;
  }

  get todayCategory() {
    return Constants.todayCategory;
  }

  get yesterdayCategory() {
    return Constants.yesterdayCategory;
  }

  get thisWeekCategory() {
    return Constants.thisWeekCategory;
  }

  get markedCategory() {
    return Constants.markedCategory;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
  }

  async ngOnInit() {
    // Workaround for auto reload
    await this.collectionService.initializeAsync();
    
    // Get notebooks
    await this.getNotebooksAsync();

    // Select 1st notebook by default
    this.selectedNotebook = this.notebooks[0];

    // Subscriptions
    this.subscription = this.collectionService.notebookAdded$.subscribe(async () => await this.getNotebooksAsync());
    this.subscription.add(this.collectionService.notebookRenamed$.subscribe(async () => await this.getNotebooksAsync()));
    this.subscription.add(this.collectionService.notebookDeleted$.subscribe(async () => await this.getNotebooksAsync()));

    this.subscription.add(this.collectionService.notesCountChanged$.subscribe((result) => {
      this.allNotesCount = result.allNotesCount;
      this.todayNotesCount = result.todayNotesCount;
      this.yesterdayNotesCount = result.yesterdayNotesCount;
      this.thisWeekNotesCount = result.thisWeekNotesCount;
      this.markedNotesCount = result.markedNotesCount;
    }));

    this.subscription.add(this.collectionService.noteMarkChanged$.subscribe((noteMarkChangedArgs) => {
      this.zone.run(() => {
        this.markedNotesCount = noteMarkChangedArgs.markedNotesCount;
      });
    }));
  }

  onSelectedTabChange(event: MatTabChangeEvent) {
    let tabIndex: number = event.index;
    let category: string = "";

    if (tabIndex === 0) {
      category = Constants.allCategory;
    } else if (tabIndex === 1) {
      category = Constants.todayCategory;
    } else if (tabIndex === 2) {
      category = Constants.yesterdayCategory;
    } else if (tabIndex === 3) {
      category = Constants.thisWeekCategory;
    } else if (tabIndex === 4) {
      category = Constants.markedCategory;
    }

    this.tabChangedSubject.next(category);
  }

  private async getNotebooksAsync(): Promise<void> {
    this.notebooks = await this.collectionService.getNotebooksAsync(true);
    this.notebooksCount = this.notebooks.length;
  }

  public async setSelectedNotebookAsync(notebook: Notebook) {
    this.selectedNotebook = notebook;
    this.canEditNotebook = this.selectedNotebook != null && !this.selectedNotebook.isDefault;
  }

  public async addNotebookAsync(): Promise<void> {
    let titleText: string = await this.translateService.get('DialogTitles.AddNotebook').toPromise();
    let placeholderText: string = await this.translateService.get('Input.NotebookName').toPromise();

    let dialogRef: MatDialogRef<InputDialogComponent> = this.dialog.open(InputDialogComponent, {
      width: '450px', data: { titleText: titleText, placeholderText: placeholderText }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result) {
        let notebookName: string = dialogRef.componentInstance.inputText;

        let operation: Operation = this.collectionService.addNotebook(notebookName);

        switch (operation) {
          case Operation.Duplicate: {
            this.snackBarService.duplicateNotebookAsync(notebookName);
            break;
          }
          case Operation.Error: {
            let generatedErrorText: string = (await this.translateService.get('ErrorTexts.AddNotebookError', { notebookName: notebookName }).toPromise());
            this.dialog.open(ErrorDialogComponent, {
              width: '450px', data: { errorText: generatedErrorText }
            });
            break;
          }
          default: {
            // Other cases don't need handling
            break;
          }
        }
      }
    });
  }

  public renameNotebook(): void {
    let dialogRef: MatDialogRef<RenameNotebookDialogComponent> = this.dialog.open(RenameNotebookDialogComponent, {
      width: '450px', data: { notebookId: this.selectedNotebook.id }
    });
  }

  public async deleteNotebookAsync(): Promise<void> {
    let notebookName: string = this.collectionService.getNotebookName(this.selectedNotebook.id);
    let title: string = await this.translateService.get('DialogTitles.ConfirmDeleteNotebook').toPromise();
    let text: string = await this.translateService.get('DialogTexts.ConfirmDeleteNotebook', { notebookName: notebookName }).toPromise();

    let dialogRef: MatDialogRef<ConfirmationDialogComponent> = this.dialog.open(ConfirmationDialogComponent, {

      width: '450px', data: { dialogTitle: title, dialogText: text }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result) {
        let operation: Operation = await this.collectionService.deleteNotebookAsync(this.selectedNotebook.id);

        if (operation === Operation.Error) {
          let generatedErrorText: string = (await this.translateService.get('ErrorTexts.DeleteNotebookError', { notebookName: notebookName }).toPromise());
          this.dialog.open(ErrorDialogComponent, {
            width: '450px', data: { errorText: generatedErrorText }
          });
        }
      }
    });
  }
}
