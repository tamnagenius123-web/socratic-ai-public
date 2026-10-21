import { getBuiltinTrainingCaseSourceBooks } from '../services/training/case-catalog';

export interface BookData { id:string; title:string; author:string; chapter:string; language:string; text:string; keyPassages:{verse:string;text:string}[]; }

// Newly authored synthetic examples; no original reading extracts are distributed here.
export const BOOKS: Record<string, BookData> = {
  "meditations-iv": {
    "id": "meditations-iv",
    "title": "Synthetic example: Sharing a fictional park",
    "author": "Synthetic fixture",
    "chapter": "Local demonstration",
    "language": "en",
    "text": "A fictional neighborhood is deciding how to share a small park. One proposal reserves mornings for quiet activities. Another proposal rotates the schedule each week. Residents ask what evidence would support a fair decision. They agree to record the effects of each proposal before making a permanent rule.",
    "keyPassages": [
      {
        "verse": "1",
        "text": "A fictional neighborhood is deciding how to share a small park."
      },
      {
        "verse": "2",
        "text": "One proposal reserves mornings for quiet activities."
      }
    ]
  },
  "republic-vii": {
    "id": "republic-vii",
    "title": "Synthetic example: Checking a fictional claim",
    "author": "Synthetic fixture",
    "chapter": "Local demonstration",
    "language": "en",
    "text": "A fictional school club observes that its garden grew faster during one week. A member suggests that a new watering schedule caused the change. Another member asks whether sunlight and temperature also changed. The club plans a fair comparison and writes down what would count as evidence against its first explanation.",
    "keyPassages": [
      {
        "verse": "1",
        "text": "A fictional school club observes that its garden grew faster during one week."
      },
      {
        "verse": "2",
        "text": "A member suggests that a new watering schedule caused the change."
      }
    ]
  },
  "nicomachean-i": {
    "id": "nicomachean-i",
    "title": "Synthetic example: Comparing fictional plans",
    "author": "Synthetic fixture",
    "chapter": "Local demonstration",
    "language": "en",
    "text": "A fictional library has enough space for one new activity. One group proposes a quiet reading corner and another proposes a discussion table. Both groups describe who might benefit and what tradeoffs they expect. They decide to compare their assumptions using the same criteria and revise their plans after hearing objections.",
    "keyPassages": [
      {
        "verse": "1",
        "text": "A fictional library has enough space for one new activity."
      },
      {
        "verse": "2",
        "text": "One group proposes a quiet reading corner and another proposes a discussion table."
      }
    ]
  }
};

export function getBook(bookId:string):BookData|null { return BOOKS[bookId] || getBuiltinTrainingCaseSourceBooks().find(book=>book.id===bookId) || null; }
export function getDefaultBook():BookData { return BOOKS["meditations-iv"]; }
export function getAllBooks():BookData[] { return [...Object.values(BOOKS),...getBuiltinTrainingCaseSourceBooks()]; }
